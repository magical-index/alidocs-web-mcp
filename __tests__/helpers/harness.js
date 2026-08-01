'use strict';

/**
 * bridge 集成测试脚手架：真实 WS server + 假 stdio 管道。
 *
 * host 侧用 PassThrough 冒充 MCP host 的 stdin/stdout；
 * page 侧用 __tests__/helpers/wsClient.js 冒充页面里的 MCP Server。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');

const { parseArgs } = require('../../src/config');
const { createBridge } = require('../../src/index');
const { connectWs } = require('./wsClient');
const { computeMac } = require('../../src/protocol/crypto');

/** 冒充 MCP host：写 stdin、读 stdout、按 id 等响应 */
class FakeHost {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.messages = [];
    this.waiters = [];
    this.idCounter = 0;
    this.buffer = '';

    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          this.messages.push(JSON.parse(line));
          this.flush();
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  flush() {
    for (const waiter of this.waiters.slice()) {
      const found = this.messages.find(waiter.predicate);
      if (found) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(found);
      }
    }
  }

  send(message) {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate, label = 'message', timeoutMs = 3000) {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待 host 消息超时: ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** 发一个请求并等它的响应 */
  async request(method, params) {
    const id = `host-${++this.idCounter}`;
    this.send({ jsonrpc: '2.0', id, method, params: params || {} });
    return this.waitFor((m) => m.id === id, `${method} 响应`);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params: params || {} });
  }

  waitNotification(method) {
    return this.waitFor((m) => m.method === method && m.id === undefined, method);
  }
}

/**
 * 起一座桥。
 *
 * @param {object} [overrides] 覆盖 config 字段
 */
async function startTestBridge(overrides) {
  const auditLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'docmcp-bridge-test-')),
    'audit.log',
  );
  const config = { ...parseArgs([]), auditLogPath, ...(overrides || {}) };

  const input = new PassThrough();
  const output = new PassThrough();
  const bridge = createBridge(config, {
    input,
    output,
    logger: () => {},
    // 测试里 stdin 关闭不得结束进程（否则会把 test runner 一起带走）
    onStdinClose: () => {},
  });
  const port = await bridge.start();
  const host = new FakeHost(input, output);

  return {
    bridge,
    host,
    port,
    config,
    auditLogPath,
    readAudit() {
      if (!fs.existsSync(auditLogPath)) return [];
      return fs
        .readFileSync(auditLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async stop() {
      await bridge.stop();
      input.destroy();
      output.destroy();
    },
  };
}

/** 完成 host 侧 initialize 握手 */
async function initializeHost(host, protocolVersion = '2025-06-18') {
  const response = await host.request('initialize', {
    protocolVersion,
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: 'test-host', version: '0.0.0' },
  });
  host.notify('notifications/initialized');
  return response;
}

/** 从 get_pairing_code 的返回里取出配对码（即 secret） */
async function fetchPairingCode(host) {
  const response = await host.request('tools/call', {
    name: 'get_pairing_code',
    arguments: {},
  });
  const pairingCode = response.result.structuredContent.pairingCode;
  return { response, pairingCode };
}

/**
 * 冒充页面：连 WS、完成挑战-响应握手（challenge → auth）、应答 bridge 的 initialize。
 *
 * @param {{ port: number, pairingCode: string, origin?: string, tools?: object[], badMac?: boolean }} options
 */
async function connectFakePage(options) {
  const {
    port,
    pairingCode,
    origin = 'https://alidocs.dingtalk.com',
    tools = [{ name: 'read_document', description: 'read', inputSchema: { type: 'object' } }],
    autoInitialize = true,
    badMac = false,
  } = options;

  const client = await connectWs({ port, origin });
  const page = {
    client,
    /** ready 控制消息（握手成功）或 error 控制消息（握手失败） */
    ready: null,
    tools,
    /** 收到的 JSON-RPC 消息（已剔除握手控制消息） */
    requests: [],
  };

  let resolveDone;
  const handshakeDone = new Promise((resolve) => {
    resolveDone = resolve;
  });

  // 先装 handler 再处理缓冲：C′ 下 bridge accept 后 **主动** 发 challenge（server-initiated），
  // 可能在 connectWs 返回后、onmessage 装配前就到达并被缓冲，需补投。
  // （真实 transport 在 open 前同步装 onmessage，无此竞态；仅测试辅助需处理）
  client.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.docmcp) {
      if (message.type === 'challenge') {
        const mac = badMac
          ? 'f'.repeat(64)
          : computeMac(pairingCode, message.nonce);
        client.sendJson({
          docmcp: 2,
          type: 'auth',
          mac,
          client: { name: 'page-client', version: 'test', toolCount: tools.length },
        });
        return;
      }
      // ready 或 error
      page.ready = message;
      resolveDone(message);
      return;
    }
    page.requests.push(message);
    if (!autoInitialize) return;
    if (message.method === 'initialize') {
      client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'alidocs-page', version: 'test' },
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      client.sendJson({ jsonrpc: '2.0', id: message.id, result: { tools } });
    }
  };

  // 补投装配前已缓冲的消息（单线程：slice 与下行之间不会有新消息插入）
  const buffered = client.messages.slice();
  for (const text of buffered) client.onmessage(text);

  await handshakeDone;
  return page;
}

/** 等待条件成立（轮询），用于观察异步状态 */
async function waitUntil(predicate, label = 'condition', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时: ${label}`);
}

module.exports = {
  startTestBridge,
  initializeHost,
  fetchPairingCode,
  connectFakePage,
  waitUntil,
  FakeHost,
};
