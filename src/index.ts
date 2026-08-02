/**
 * alidocs-web-mcp 组装层。
 *
 * ```
 * MCP host ──stdio(JSON-RPC)──▶ StdioChannel ──▶ Router ──▶ PageSessionManager ──ws──▶ 页面 MCP Server
 * ```
 *
 * bridge 自有工具（其余全部透传，bridge 不理解工具语义）：
 * - get_pairing_code：以「数据」下发配对码（高熵 secret），供页面填入配对框（S13：不返回可执行代码）
 * - get_bridge_status：桥状态与结构化诊断
 * - revoke_session：轮换密钥并断开当前会话（S11 撤销）
 * - call_page_tool：静态透传兜底；部分 host 不刷新 tools/list，可用它显式调用页面工具
 */

import * as fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { SecretStore } from './secrets.js';
import { AuditLog } from './audit.js';
import {
  createWsServer,
  type BridgeHealthStatus,
  type WsServerHandle,
} from './wsServer.js';
import {
  PageSessionManager,
  type PageSession,
  type ClientSummary,
} from './session.js';
import {
  Router,
  toolError,
  type ToolDefinition,
  type ToolResult,
} from './router.js';
import { StdioChannel } from './stdio.js';
import { CLOSE_CODE } from './protocol/index.js';
import type { BridgeConfig } from './config.js';

/**
 * 版本号在运行时从 package.json 读取。
 *
 * 不用 `import '../package.json'`：那会越出 rootDir（src），且把 package.json 打进产物。
 * 本包是 ESM（`"type": "module"`），**没有 `__dirname`**——用 `import.meta.url` 定位：
 * `../package.json` 在 dist（发布态，dist/index.js）与 src（开发态）下都指向包根。
 */
export const VERSION: string = (() => {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(pkgUrl, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const LOCAL_TOOLS: ToolDefinition[] = [
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
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_bridge_status',
    title: '查询桥状态',
    description:
      '返回 bridge 当前状态：监听端口、是否已建桥、页面 MCP 会话是否就绪、在途请求数、Origin 白名单、写权限开关。工具调用失败时先查这里。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'revoke_session',
    title: '撤销连接',
    description:
      '轮换配对码并断开当前页面会话（S11）。撤销后旧配对码立即失效，页面 sessionStorage 里的旧值无法再重连，需重新调用 get_pairing_code 配对。用于结束一次授权或怀疑配对码泄露时。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'call_page_tool',
    title: '调用页面工具（静态透传）',
    description: [
      '显式按名字调用一个由已建桥页面提供的文档工具。',
      '适用场景：部分 MCP host 在 server 启动后不会刷新 tools/list（不响应 notifications/tools/list_changed），',
      '因此页面配对后新出现的 read_document / insert_blocks 等工具对 host 不可见。',
      'call_page_tool 恒定出现在 tools/list 中，它只按 name 与 arguments 原样转发给页面，',
      '桥仍不理解工具语义（A10 哑管道约束）。',
      '未建桥时返回 PAGE_NOT_CONNECTED。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            '要调用的页面侧工具名，例如 read_document、insert_blocks。',
        },
        arguments: {
          type: 'object',
          description: '传给该页面工具的参数对象。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

/**
 * bridge 自有工具的 `structuredContent` 契约。host 侧 agent 与测试都按这些形状读。
 *
 * 用 `type` 而非 `interface`：需要能赋给 `ToolResult.structuredContent`
 * （`Record<string, unknown>`），而 interface 不带隐式索引签名。
 */

/** get_pairing_code：只回数据，绕不回可执行代码（A2 / S13） */
export type PairingCodeStatus = {
  ok: true;
  pairingCode: string;
  port: number;
  allowWrite: boolean;
  version: string;
};

/** get_bridge_status：桥状态与结构化诊断（含 `/health` 那四个字段） */
export type BridgeStatus = BridgeHealthStatus & {
  ok: true;
  version: string;
  session: {
    id: string;
    origin: string;
    startedAt: string;
    client: ClientSummary;
  } | null;
  pendingHostRequests: number;
  allowedOrigins: string[];
  auditLog: string | null;
  hint: string;
};

/** revoke_session：已轮换配对码并断开会话（S11） */
export type RevokeStatus = {
  ok: true;
  revoked: true;
  hint: string;
};

export interface BridgeIo {
  input?: Readable;
  output?: Writable;
  logger?: (line: string) => void;
  onStdinClose?: () => void;
  secretStore?: SecretStore;
}

export interface Bridge {
  start(): Promise<number>;
  stop(): Promise<void>;
  readonly port: number | null;
  router: Router;
  sessions: PageSessionManager;
  secretStore: SecretStore;
  audit: AuditLog;
  stdio: StdioChannel;
  wsServer: WsServerHandle;
  localTools: ToolDefinition[];
  version: string;
}

/** 创建 bridge（不自动启动） */
export function createBridge(config: BridgeConfig, io?: BridgeIo): Bridge {
  const options = io ?? {};
  const logger =
    options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));

  const audit = new AuditLog({ filePath: config.auditLogPath });
  const secretStore = options.secretStore ?? new SecretStore();

  let listeningPort: number | null = null;

  const log = (message: string, fields?: Record<string, unknown>): void => {
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
      log('stdin 收到非法 JSON', {
        message: error.message,
        bytes: line.length,
      });
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
  sessions.onSessionOpen = (session: PageSession) => {
    log('页面已建桥', { sessionId: session.id, origin: session.origin });
    void router.handlePageOpen(session);
  };
  sessions.onSessionClose = (session, info) => {
    router.handlePageClose(session, info);
  };

  /** health 白名单内暴露的最小状态（不含 secret / 文档信息 / 会话 Origin） */
  const getPublicStatus = (): BridgeHealthStatus => ({
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
  async function callLocalTool(
    name: string,
    args: unknown,
  ): Promise<ToolResult> {
    if (name === 'call_page_tool') {
      const payload = args as { name?: unknown; arguments?: unknown };
      const toolName =
        typeof payload.name === 'string' && payload.name.length > 0
          ? payload.name
          : null;
      if (toolName === null) {
        return toolError(
          'INVALID_PARAMS',
          'call_page_tool 需要非空字符串参数 name',
        );
      }
      const toolArgs = payload.arguments === undefined ? {} : payload.arguments;
      if (typeof toolArgs !== 'object' || toolArgs === null) {
        return toolError(
          'INVALID_PARAMS',
          'call_page_tool 的 arguments 必须是对象',
        );
      }
      return router.callPageTool(toolName, toolArgs);
    }

    if (name === 'get_pairing_code') {
      if (listeningPort === null) {
        return toolError('BRIDGE_NOT_LISTENING', 'bridge 尚未开始监听端口');
      }
      const { pairingCode } = secretStore;

      audit.write('pairing.issued', { port: listeningPort });

      const status: PairingCodeStatus = {
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
      const status: BridgeStatus = {
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
        pendingHostRequests: router.pendingHostRequestCount,
        allowedOrigins: config.allowedOrigins,
        auditLog: audit.path,
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
      const status: RevokeStatus = {
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

  async function start(): Promise<number> {
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
      audit: audit.path ?? 'disabled',
    });
    return listeningPort;
  }

  async function stop(): Promise<void> {
    router.dispose();
    sessions.closeCurrent(CLOSE_CODE.NORMAL, 'bridge shutting down');
    await ws.close();
    audit.write('bridge.stop', { port: listeningPort });
  }

  return {
    start,
    stop,
    get port(): number | null {
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
