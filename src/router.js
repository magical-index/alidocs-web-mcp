'use strict';

/**
 * stdio ↔ WS 的 JSON-RPC 路由。
 *
 * 设计要点（详见 docs/design.md）：
 * - **哑管道**：除 MCP 会话生命周期（initialize / 能力协商）与 bridge 自有的两个本地工具外，
 *   一切请求原样转发给页面，bridge 不理解文档工具语义
 * - **id 重映射**：三条来源各自加前缀（h=host→page，b=bridge→page，p=page→host），
 *   避免 id 撞车，也保证断连时能精准回收
 * - **不挂起**：页面未连接 / 超时 / 断桥时立即返回结构化错误（S7），agent 不空等
 */

const { SERVICE_ID } = require('./protocol/index');

const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC 自定义错误码：桥不可用（区别于协议层错误） */
const ERROR_BRIDGE_UNAVAILABLE = -32001;
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;

const INSTRUCTIONS = [
  '本 server 是钉钉文档（alidocs）的本地 MCP 桥。文档工具由「当前已建桥的文档页面」提供，',
  '因此接入分三步：',
  '1. 调用 get_pairing_code 获取配对码（字符串数据，不是脚本）；',
  '2. 在已打开的钉钉文档页面的「连接本地 Agent」配对框里填入该配对码并确认（如 fill + click）；页面与 bridge 完成挑战-响应握手；',
  '3. 之后 tools/list 会出现文档工具（read_document / get_blocks / update_block 等），按标准 MCP 调用。',
  '页面刷新/跳转后由页面用 sessionStorage 里的配对码自动重连；若工具调用返回 PAGE_DISCONNECTED，稍候重试或重新配对。',
  '写工具产生的改动停留在 diffBlock 建议态，accept_all_changes / reject_all_changes 必须先获得用户明确许可。',
].join('\n');

class Router {
  /**
   * @param {{
   *   version: string,
   *   requestTimeoutMs: number,
   *   sendToHost: (message: object) => void,
   *   sendToPage: (message: object) => boolean,
   *   isPageConnected: () => boolean,
   *   localTools: object[],
   *   callLocalTool: (name: string, args: unknown) => Promise<object>,
   *   audit?: { write: (event: string, fields?: object) => void },
   *   log?: (message: string, fields?: object) => void,
   * }} options
   */
  constructor(options) {
    this.version = options.version;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.sendToHost = options.sendToHost;
    this.sendToPage = options.sendToPage;
    this.isPageConnected = options.isPageConnected;
    this.localTools = options.localTools;
    this.localToolNames = new Set(options.localTools.map((tool) => tool.name));
    this.callLocalTool = options.callLocalTool;
    this.audit = options.audit || { write: () => {} };
    this.log = options.log || (() => {});

    this.hostInitialized = false;
    this.hostProtocolVersion = LATEST_PROTOCOL_VERSION;
    this.hostCapabilities = {};
    this.hostClientInfo = null;

    this.idCounter = 0;
    /** host→page 在途请求：bridgeId -> { hostId, method, timer } */
    this.hostPending = new Map();
    /** bridge→page 在途请求：bridgeId -> { resolve, reject, timer } */
    this.bridgePending = new Map();
    /** page→host 在途请求：bridgeId -> { pageId } */
    this.pagePending = new Map();

    this.pageReady = false;
  }

  nextId(prefix) {
    this.idCounter += 1;
    return `${prefix}${this.idCounter}`;
  }

  // ---------- host（stdio）方向 ----------

  /** 处理来自 MCP host 的一条 JSON-RPC 消息 */
  handleHostMessage(message) {
    if (!message || typeof message !== 'object') return;

    // host 对「page→host 请求」的响应：换回 page 的原 id 后回传
    if (isResponse(message)) {
      const entry = this.pagePending.get(String(message.id));
      if (!entry) {
        this.log('丢弃无主的 host 响应', { id: message.id });
        return;
      }
      this.pagePending.delete(String(message.id));
      this.sendToPage({ ...message, id: entry.pageId });
      return;
    }

    if (isNotification(message)) {
      this.handleHostNotification(message);
      return;
    }

    this.handleHostRequest(message).catch((error) => {
      this.replyError(
        message.id,
        ERROR_BRIDGE_UNAVAILABLE,
        `bridge 内部错误: ${error && error.message ? error.message : String(error)}`,
      );
    });
  }

  handleHostNotification(message) {
    if (message.method === 'notifications/initialized') {
      this.hostInitialized = true;
      return;
    }
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params && message.params.requestId;
      const bridgeId = this.findBridgeIdByHostId(requestId);
      if (bridgeId) {
        const entry = this.hostPending.get(bridgeId);
        this.clearHostPending(bridgeId);
        this.forwardToPage({
          ...message,
          params: { ...message.params, requestId: bridgeId },
        });
        this.log('取消已转发的请求', { method: entry && entry.method });
      }
      return;
    }
    // roots/list_changed 等：页面在线才转发
    this.forwardToPage(message);
  }

  async handleHostRequest(message) {
    const { method, id } = message;

    if (method === 'initialize') {
      this.replyResult(id, this.buildInitializeResult(message.params));
      return;
    }
    if (method === 'ping') {
      this.replyResult(id, {});
      return;
    }
    if (method === 'tools/list') {
      await this.handleToolsList(message);
      return;
    }
    if (method === 'tools/call') {
      await this.handleToolsCall(message);
      return;
    }

    // 其余一律转发（resources/* prompts/* completion/* logging/*）
    if (!this.isPageConnected()) {
      this.replyError(
        id,
        method.startsWith('resources/') || method.startsWith('prompts/')
          ? ERROR_BRIDGE_UNAVAILABLE
          : ERROR_METHOD_NOT_FOUND,
        '页面未建桥，该能力由文档页面提供',
        this.disconnectedData(),
      );
      return;
    }
    this.forwardHostRequest(message);
  }

  buildInitializeResult(params) {
    const requested = params && params.protocolVersion;
    this.hostProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    this.hostCapabilities = (params && params.capabilities) || {};
    this.hostClientInfo = (params && params.clientInfo) || null;

    return {
      protocolVersion: this.hostProtocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
      serverInfo: {
        name: SERVICE_ID,
        title: 'DingTalk Doc MCP Bridge',
        version: this.version,
      },
      instructions: INSTRUCTIONS,
    };
  }

  async handleToolsList(message) {
    const { id, params } = message;

    // 带 cursor 的翻页请求语义属于页面，原样转发，不再混入本地工具
    if (params && params.cursor) {
      if (!this.isPageConnected()) {
        this.replyError(
          id,
          ERROR_INVALID_PARAMS,
          '页面未建桥，cursor 已失效',
          this.disconnectedData(),
        );
        return;
      }
      this.forwardHostRequest(message);
      return;
    }

    if (!this.isPageConnected()) {
      this.replyResult(id, { tools: this.localTools });
      return;
    }

    try {
      const result = await this.requestPage('tools/list', {});
      const pageTools = Array.isArray(result && result.tools) ? result.tools : [];
      const merged = this.localTools.concat(
        pageTools.filter((tool) => tool && !this.localToolNames.has(tool.name)),
      );
      const payload = { tools: merged };
      if (result && result.nextCursor) payload.nextCursor = result.nextCursor;
      this.replyResult(id, payload);
    } catch (error) {
      // 取页面工具失败不应让 tools/list 整体失败：至少返回本地工具 + 诊断
      this.log('page tools/list 失败，降级为仅本地工具', {
        message: error && error.message,
      });
      this.replyResult(id, { tools: this.localTools });
    }
  }

  async handleToolsCall(message) {
    const { id, params } = message;
    const name = params && params.name;

    // S9 审计：只记工具名与参数 key，不记参数值
    this.audit.write('tool.call', {
      tool: name,
      target: this.localToolNames.has(name) ? 'bridge' : 'page',
      argKeys: safeArgKeys(params && params.arguments),
      pageConnected: this.isPageConnected(),
    });

    if (this.localToolNames.has(name)) {
      const result = await this.callLocalTool(name, (params && params.arguments) || {});
      this.replyResult(id, result);
      return;
    }

    if (!this.isPageConnected()) {
      // 工具执行层错误用 isError 结果表达，便于 agent 读到自愈指引
      this.replyResult(id, toolError('PAGE_NOT_CONNECTED', [
        '桥未建立：文档工具由已建桥的钉钉文档页面提供。',
        '请先调用 get_pairing_code，在文档页面配对框填入配对码完成握手，然后重试。',
      ].join('\n')));
      return;
    }

    this.forwardHostRequest(message);
  }

  // ---------- page（WS）方向 ----------

  /** 处理来自页面的一条 JSON-RPC 消息 */
  handlePageMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (isResponse(message)) {
      const key = String(message.id);

      const bridgeEntry = this.bridgePending.get(key);
      if (bridgeEntry) {
        this.bridgePending.delete(key);
        clearTimeout(bridgeEntry.timer);
        if (message.error) {
          bridgeEntry.reject(
            new Error(message.error.message || 'page returned error'),
          );
        } else {
          bridgeEntry.resolve(message.result);
        }
        return;
      }

      const hostEntry = this.hostPending.get(key);
      if (hostEntry) {
        this.clearHostPending(key);
        this.sendToHost({ ...message, id: hostEntry.hostId });
        return;
      }

      this.log('丢弃无主的 page 响应', { id: message.id });
      return;
    }

    if (isNotification(message)) {
      // list_changed / resources/updated / message 等原样上抛
      this.sendToHost(message);
      return;
    }

    // 页面反向请求（sampling / roots / elicitation）：换 id 后转给 host
    const bridgeId = this.nextId('p');
    this.pagePending.set(bridgeId, { pageId: message.id });
    this.sendToHost({ ...message, id: bridgeId });
  }

  /** 页面会话建立：bridge 作为 MCP client 完成对页面的 initialize，然后通知 host 刷新工具 */
  async handlePageOpen(session) {
    this.pageReady = false;
    try {
      await this.requestPage('initialize', {
        protocolVersion: this.hostProtocolVersion,
        capabilities: this.hostCapabilities,
        clientInfo: {
          name: SERVICE_ID,
          version: this.version,
        },
      });
      this.sendToPage({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.pageReady = true;
      this.log('页面 MCP 会话就绪', { sessionId: session && session.id });
    } catch (error) {
      this.log('页面 initialize 失败', { message: error && error.message });
    }
    this.notifyToolsListChanged();
  }

  /** 页面会话断开：回收在途请求（结构化错误，不挂起），并让 host 刷新工具列表 */
  handlePageClose(session, info) {
    this.pageReady = false;
    const reason =
      info && info.code === 4008 ? 'PAGE_SUPERSEDED' : 'PAGE_DISCONNECTED';

    for (const [bridgeId, entry] of this.hostPending) {
      clearTimeout(entry.timer);
      this.sendToHost({
        jsonrpc: '2.0',
        id: entry.hostId,
        error: {
          code: ERROR_BRIDGE_UNAVAILABLE,
          message: `页面会话已断开（${reason}），请求未完成`,
          data: this.disconnectedData(reason),
        },
      });
      this.hostPending.delete(bridgeId);
    }
    for (const [bridgeId, entry] of this.bridgePending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.bridgePending.delete(bridgeId);
    }
    this.pagePending.clear();

    this.log('页面会话关闭', { sessionId: session && session.id, reason });
    this.notifyToolsListChanged();
  }

  // ---------- 转发与应答工具 ----------

  /** 把 host 请求转发给页面并登记在途（含超时兜底） */
  forwardHostRequest(message) {
    const bridgeId = this.nextId('h');
    const timer = setTimeout(() => {
      this.clearHostPending(bridgeId);
      this.sendToPage({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: bridgeId, reason: 'bridge request timeout' },
      });
      this.sendToHost({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: ERROR_BRIDGE_UNAVAILABLE,
          message: `页面 ${this.requestTimeoutMs}ms 未响应（PAGE_TIMEOUT）`,
          data: { code: 'PAGE_TIMEOUT', method: message.method },
        },
      });
    }, this.requestTimeoutMs);
    if (timer.unref) timer.unref();

    this.hostPending.set(bridgeId, {
      hostId: message.id,
      method: message.method,
      timer,
    });
    const delivered = this.sendToPage({ ...message, id: bridgeId });
    if (!delivered) {
      this.clearHostPending(bridgeId);
      this.replyError(
        message.id,
        ERROR_BRIDGE_UNAVAILABLE,
        '页面未建桥，请求未发出',
        this.disconnectedData(),
      );
    }
  }

  /** bridge 自身向页面发请求（initialize / tools/list 合并） */
  requestPage(method, params) {
    return new Promise((resolve, reject) => {
      const bridgeId = this.nextId('b');
      const timer = setTimeout(() => {
        this.bridgePending.delete(bridgeId);
        reject(new Error(`page ${method} timeout`));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();

      this.bridgePending.set(bridgeId, { resolve, reject, timer });
      const delivered = this.sendToPage({
        jsonrpc: '2.0',
        id: bridgeId,
        method,
        params: params || {},
      });
      if (!delivered) {
        this.bridgePending.delete(bridgeId);
        clearTimeout(timer);
        reject(new Error('PAGE_NOT_CONNECTED'));
      }
    });
  }

  forwardToPage(message) {
    if (!this.isPageConnected()) return false;
    return this.sendToPage(message);
  }

  notifyToolsListChanged() {
    if (!this.hostInitialized) return;
    this.sendToHost({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
  }

  clearHostPending(bridgeId) {
    const entry = this.hostPending.get(bridgeId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.hostPending.delete(bridgeId);
  }

  findBridgeIdByHostId(hostId) {
    for (const [bridgeId, entry] of this.hostPending) {
      if (String(entry.hostId) === String(hostId)) return bridgeId;
    }
    return null;
  }

  replyResult(id, result) {
    this.sendToHost({ jsonrpc: '2.0', id, result });
  }

  replyError(id, code, message, data) {
    const error = { code, message };
    if (data) error.data = data;
    this.sendToHost({ jsonrpc: '2.0', id, error });
  }

  disconnectedData(code) {
    return {
      code: code || 'PAGE_NOT_CONNECTED',
      hint: '调用 get_pairing_code 获取配对码，在钉钉文档页配对框填入后重试',
    };
  }

  /** 释放全部定时器（进程退出时调用） */
  dispose() {
    for (const [, entry] of this.hostPending) clearTimeout(entry.timer);
    for (const [, entry] of this.bridgePending) clearTimeout(entry.timer);
    this.hostPending.clear();
    this.bridgePending.clear();
    this.pagePending.clear();
  }
}

function isNotification(message) {
  return message.method !== undefined && message.id === undefined;
}

function isResponse(message) {
  return (
    message.method === undefined &&
    message.id !== undefined &&
    (message.result !== undefined || message.error !== undefined)
  );
}

/** 构造 isError 工具结果（工具层错误按 MCP 约定不用 JSON-RPC error 表达） */
function toolError(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}` }],
    structuredContent: { ok: false, code, message },
  };
}

/** 提取参数 key 名用于审计（值一律不落盘） */
function safeArgKeys(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.keys(args);
}

module.exports = {
  Router,
  toolError,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ERROR_BRIDGE_UNAVAILABLE,
  INSTRUCTIONS,
};
