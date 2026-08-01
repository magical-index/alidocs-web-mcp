'use strict';

/**
 * alidocs-web-mcp 组装层。
 *
 * ```
 * MCP host  ──stdio(JSON-RPC)──▶ StdioChannel ──▶ Router ──▶ PageSessionManager ──ws──▶ 页面 MCP Server
 * ```
 *
 * bridge 自有工具（其余全部透传，bridge 不理解工具语义）：
 * - get_pairing_code：以「数据」下发配对码（高熵 secret），供页面填入配对框（S13：不返回可执行代码）
 * - get_bridge_status：桥状态与结构化诊断
 * - revoke_session：轮换密钥并断开当前会话（S11 撤销）
 */

const { SecretStore } = require('./secrets');
const { AuditLog } = require('./audit');
const { createWsServer } = require('./wsServer');
const { PageSessionManager } = require('./session');
const { Router, toolError } = require('./router');
const { StdioChannel } = require('./stdio');
const { CLOSE_CODE } = require('./protocol');

const VERSION = require('../package.json').version;

const LOCAL_TOOLS = [
  {
    name: 'get_pairing_code',
    title: '获取配对码',
    description: [
      '返回把「当前浏览器里已打开的钉钉文档页面」接到本 bridge 所需的配对码（一串字符串数据）。',
      '用法：把 pairingCode 与 port 交给页面的配对入口——',
      '  · agent 场景：在文档页面的「连接本地 Agent」配对框里填入 pairingCode 并确认（如 fill + click）；',
      '  · 人工场景：用户从终端复制配对码粘贴。',
      '页面据此与 bridge 完成挑战-响应握手（配对码只用于本地计算 HMAC，明文永不上线）。',
      '重要：本工具只返回数据，绝不返回需要执行的脚本；不要 eval 任何东西。',
      '握手成功后 tools/list 会包含文档工具。页面刷新后由页面用 sessionStorage 里的配对码自动重连，无需再次配对。',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_bridge_status',
    title: '查询桥状态',
    description:
      '返回 bridge 当前状态：监听端口、是否已建桥、页面 MCP 会话是否就绪、在途请求数、Origin 白名单、写权限开关。工具调用失败时先查这里。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'revoke_session',
    title: '撤销连接',
    description:
      '轮换配对码并断开当前页面会话（S11）。撤销后旧配对码立即失效，页面 sessionStorage 里的旧值无法再重连，需重新调用 get_pairing_code 配对。用于结束一次授权或怀疑配对码泄露时。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

/**
 * 创建 bridge（不自动启动）。
 *
 * @param {object} config 见 config.js parseArgs 的返回值
 * @param {{
 *   input?: import('stream').Readable,
 *   output?: import('stream').Writable,
 *   logger?: (line: string) => void,
 *   onStdinClose?: () => void,
 *   secretStore?: object,
 * }} [io]
 */
function createBridge(config, io) {
  const options = io || {};
  const logger =
    options.logger || ((line) => process.stderr.write(`${line}\n`));

  const audit = new AuditLog({ filePath: config.auditLogPath });
  const secretStore = options.secretStore || new SecretStore();

  let listeningPort = null;

  const log = (message, fields) => {
    const suffix = fields ? ` ${JSON.stringify(fields)}` : '';
    logger(`[alidocs-web-mcp] ${message}${suffix}`);
  };

  const sessions = new PageSessionManager({
    secretStore,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    version: VERSION,
    allowWrite: config.allowWrite,
    audit,
  });

  const router = new Router({
    version: VERSION,
    requestTimeoutMs: config.requestTimeoutMs,
    sendToHost: (message) => stdio.send(message),
    sendToPage: (message) => sessions.sendJsonRpc(message),
    isPageConnected: () => sessions.connected,
    localTools: LOCAL_TOOLS,
    callLocalTool: (name, args) => callLocalTool(name, args),
    audit,
    log,
  });

  const stdio = new StdioChannel({
    input: options.input,
    output: options.output,
    onMessage: (message) => router.handleHostMessage(message),
    onParseError: (line, error) => {
      log('stdin 收到非法 JSON', { message: error.message, bytes: line.length });
    },
    onClose: () => {
      log('stdin 关闭');
      if (options.onStdinClose) {
        options.onStdinClose();
        return;
      }
      stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    },
  });

  sessions.onJsonRpc = (message) => router.handlePageMessage(message);
  sessions.onSessionOpen = (session) => {
    log('页面已建桥', { sessionId: session.id, origin: session.origin });
    router.handlePageOpen(session);
  };
  sessions.onSessionClose = (session, info) => {
    router.handlePageClose(session, info);
  };

  /** health 白名单内暴露的最小状态（不含 secret / 文档信息 / 会话 Origin） */
  const getPublicStatus = () => ({
    port: listeningPort,
    connected: sessions.connected,
    pageReady: router.pageReady,
    allowWrite: config.allowWrite,
  });

  const ws = createWsServer({
    host: config.host,
    portCandidates: config.portCandidates,
    allowedOrigins: config.allowedOrigins,
    version: VERSION,
    audit,
    getStatus: getPublicStatus,
    onConnection: (connection) => sessions.accept(connection),
  });

  /** bridge 自有工具的执行 */
  async function callLocalTool(name, args) {
    void args;
    if (name === 'get_pairing_code') {
      if (listeningPort === null) {
        return toolError('BRIDGE_NOT_LISTENING', 'bridge 尚未开始监听端口');
      }
      const pairingCode = secretStore.pairingCode;

      audit.write('pairing.issued', { port: listeningPort });

      const status = {
        ok: true,
        pairingCode,
        port: listeningPort,
        allowWrite: config.allowWrite,
        version: VERSION,
      };
      return {
        content: [
          {
            type: 'text',
            text: [
              '配对码（把它填入文档页面的「连接本地 Agent」配对框，或让用户从终端复制粘贴）：',
              '',
              pairingCode,
              '',
              `bridge 端口 ${listeningPort}；allowWrite=${config.allowWrite}。`,
              '这是数据，不是脚本——请勿 eval，只需把它填进配对框。',
              '页面完成挑战-响应握手后，tools/list 即包含文档工具。',
            ].join('\n'),
          },
        ],
        structuredContent: status,
      };
    }

    if (name === 'get_bridge_status') {
      const session = sessions.current;
      const status = {
        ok: true,
        version: VERSION,
        ...getPublicStatus(),
        session: session
          ? {
              id: session.id,
              origin: session.origin,
              startedAt: new Date(session.startedAt).toISOString(),
              client: session.client,
            }
          : null,
        pendingHostRequests: router.hostPending.size,
        allowedOrigins: config.allowedOrigins,
        auditLog: audit.enabled ? audit.filePath : null,
        hint: sessions.connected
          ? '桥已建立，可直接调用文档工具'
          : '未建桥：调用 get_pairing_code，在文档页面配对框填入配对码',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    }

    if (name === 'revoke_session') {
      secretStore.rotate();
      sessions.closeCurrent(CLOSE_CODE.NORMAL, 'revoked by host');
      audit.write('session.revoked', {});
      const status = {
        ok: true,
        revoked: true,
        hint: '已轮换配对码并断开会话；重新连接需调用 get_pairing_code 再配对',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    }

    return toolError('UNKNOWN_TOOL', `bridge 不认识工具: ${name}`);
  }

  async function start() {
    listeningPort = await ws.listen();
    audit.write('bridge.start', {
      port: listeningPort,
      allowWrite: config.allowWrite,
      allowedOrigins: config.allowedOrigins,
    });
    log('已启动', {
      port: listeningPort,
      host: config.host,
      allowWrite: config.allowWrite,
      audit: audit.enabled ? audit.filePath : 'disabled',
    });
    return listeningPort;
  }

  async function stop() {
    router.dispose();
    sessions.closeCurrent(CLOSE_CODE.NORMAL, 'bridge shutting down');
    await ws.close();
    audit.write('bridge.stop', { port: listeningPort });
  }

  return {
    start,
    stop,
    get port() {
      return listeningPort;
    },
    router,
    sessions,
    secretStore,
    audit,
    stdio,
    wsServer: ws,
    localTools: LOCAL_TOOLS,
    version: VERSION,
  };
}

module.exports = { createBridge, LOCAL_TOOLS, VERSION };
