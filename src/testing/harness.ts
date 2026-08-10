/**
 * bridge 集成测试脚手架：真实 WS server + 假 stdio 管道。
 *
 * 作为**公开 API** 提供（`alidocs-web-mcp/testing`）：下游可用真实 bridge 进程
 * 做契约测试，而不是各自 mock。
 *
 * host 侧用 PassThrough 冒充 MCP host 的 stdin/stdout；
 * page 侧用 `wsClient.ts` 冒充页面里的 MCP Server。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';

import { parseArgs, type BridgeConfig } from '../config.js';
import { createBridge, type Bridge, type PairingCodeStatus } from '../index.js';
import type { BridgeErrorData, ToolDefinition } from '../router.js';
import { connectWs, type TestWsClient } from './wsClient.js';
import { computeMac } from '../protocol/crypto.js';
import { parsePairingCode } from '../protocol/pairingCode.js';
import {
  CONTROL_TYPE,
  PROTOCOL_VERSION,
  type ErrorMessage,
  type ReadyMessage,
} from '../protocol/index.js';

export interface HostMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: BridgeErrorData };
}

/** MCP `initialize` 结果（bridge 自报的身份与能力） */
export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: { tools?: { listChanged?: boolean } };
  instructions?: string;
}

/** MCP `tools/list` 结果（bridge 自有工具 + 页面工具合并后） */
export interface ToolsListResult {
  tools: ToolDefinition[];
}

/** MCP `tools/call` 结果；`S` 为该工具的 structuredContent 形状 */
export interface ToolCallResult<S = Record<string, unknown>> {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: S;
}

/** 握手结果：ready（成功）或 error（被拒） */
export type PageHandshakeResult = ReadyMessage | ErrorMessage;

interface HostWaiter {
  predicate: (m: HostMessage) => boolean;
  resolve: (m: HostMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** 冒充 MCP host：写 stdin、读 stdout、按谓词等消息 */
export class FakeHost {
  readonly messages: HostMessage[] = [];

  private readonly input: PassThrough;

  private waiters: HostWaiter[] = [];

  private idCounter = 0;

  private buffer = '';

  constructor(input: PassThrough, output: PassThrough) {
    this.input = input;

    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          this.messages.push(JSON.parse(line) as HostMessage);
          this.flush();
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  private flush(): void {
    for (const waiter of this.waiters.slice()) {
      const found = this.messages.find(waiter.predicate);
      if (found) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(found);
      }
    }
  }

  send(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(
    predicate: (m: HostMessage) => boolean,
    label = 'message',
    timeoutMs = 3000,
  ): Promise<HostMessage> {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<HostMessage>((resolve, reject) => {
      const waiter: HostWaiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待 host 消息超时: ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** 发一个请求并等它的响应 */
  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<HostMessage> {
    this.idCounter += 1;
    const id = `host-${this.idCounter}`;
    this.send({ jsonrpc: '2.0', id, method, params: params || {} });
    return this.waitFor((m) => m.id === id, `${method} 响应`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params: params || {} });
  }

  waitNotification(method: string): Promise<HostMessage> {
    return this.waitFor(
      (m) => m.method === method && m.id === undefined,
      method,
    );
  }
}

/**
 * 取出 JSON-RPC 响应的 `result` 并收窄到调用方给定的形状。
 *
 * 收到 error 或没有 result 时**直接抛错**（而不是让断言在 undefined 上继续跑），
 * 抛出的错误带上原始消息，失败时一眼能看出桥到底回了什么。
 */
export function resultOf<R = Record<string, unknown>>(message: HostMessage): R {
  if (message.error) {
    throw new Error(
      `期望 result，实际收到 JSON-RPC error: ${JSON.stringify(message.error)}`,
    );
  }
  if (message.result === undefined) {
    throw new Error(`响应里没有 result: ${JSON.stringify(message)}`);
  }
  return message.result as R;
}

/** 取出 JSON-RPC 响应的 `error`（含结构化 data）；不是错误响应则抛错 */
export function errorOf(message: HostMessage): {
  code: number;
  message: string;
  data: BridgeErrorData;
} {
  const { error } = message;
  if (!error) {
    throw new Error(
      `期望 JSON-RPC error，实际收到: ${JSON.stringify(message)}`,
    );
  }
  if (!error.data) {
    throw new Error(`error 缺结构化 data: ${JSON.stringify(error)}`);
  }
  return { code: error.code, message: error.message, data: error.data };
}

/** 取出 `tools/call` 结果里的 `structuredContent` 并收窄；缺失即抛 */
export function structuredOf<S = Record<string, unknown>>(
  message: HostMessage,
): S {
  const result = resultOf<ToolCallResult<S>>(message);
  if (result.structuredContent === undefined) {
    throw new Error(
      `工具结果里没有 structuredContent: ${JSON.stringify(result)}`,
    );
  }
  return result.structuredContent;
}

export interface TestBridgeHandle {
  bridge: Bridge;
  host: FakeHost;
  port: number;
  config: BridgeConfig;
  auditLogPath: string;
  readAudit(): Record<string, unknown>[];
  stop(): Promise<void>;
}

/** 起一座桥（真实 WS server + 假 stdio） */
export async function startTestBridge(
  overrides?: Partial<BridgeConfig>,
): Promise<TestBridgeHandle> {
  const auditLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'alidocs-web-mcp-test-')),
    'audit.log',
  );
  const config: BridgeConfig = {
    ...parseArgs([]),
    auditLogPath,
    ...(overrides || {}),
  };

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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async stop() {
      await bridge.stop();
      input.destroy();
      output.destroy();
    },
  };
}

/** 完成 host 侧 initialize 握手 */
export async function initializeHost(
  host: FakeHost,
  protocolVersion = '2025-06-18',
): Promise<HostMessage> {
  const response = await host.request('initialize', {
    protocolVersion,
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: 'test-host', version: '0.0.0' },
  });
  host.notify('notifications/initialized');
  return response;
}

/**
 * 调 get_pairing_code，返回原响应、结构化状态与配对码。
 *
 * `pairingCode` 是复合 token `<port>.<secret>`（0.2.0 起）；`secret` / `port` 是它
 * 解析后的两段。**算 mac 要用 `secret`**——整串传给 `computeMac` 必然 `AUTH_FAILED`。
 */
export async function fetchPairingCode(host: FakeHost): Promise<{
  response: HostMessage;
  status: PairingCodeStatus;
  pairingCode: string;
  secret: string;
  port: number | null;
}> {
  const response = await host.request('tools/call', {
    name: 'get_pairing_code',
    arguments: {},
  });
  const status =
    resultOf<ToolCallResult<PairingCodeStatus>>(response).structuredContent;
  if (!status?.pairingCode) {
    throw new Error(
      `get_pairing_code 未返回配对码: ${JSON.stringify(response)}`,
    );
  }
  const { port, secret } = parsePairingCode(status.pairingCode);
  return { response, status, pairingCode: status.pairingCode, secret, port };
}

export interface PageToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface FakePage {
  client: TestWsClient;
  /** 握手结果控制消息；connectFakePage 返回时必然已就位 */
  ready: PageHandshakeResult;
  tools: PageToolDefinition[];
  /** 收到的 JSON-RPC 消息（已剔除握手控制消息） */
  requests: HostMessage[];
}

/** 断言握手成功并取 ready 消息（否则抛错，带上桥给的错误码） */
export function readyOf(page: FakePage): ReadyMessage {
  if (page.ready.type !== CONTROL_TYPE.READY) {
    throw new Error(`握手未成功: ${JSON.stringify(page.ready)}`);
  }
  return page.ready;
}

/** 断言握手被拒并取 error 消息（否则抛错） */
export function handshakeErrorOf(page: FakePage): ErrorMessage {
  if (page.ready.type !== CONTROL_TYPE.ERROR) {
    throw new Error(`期望握手被拒，实际: ${JSON.stringify(page.ready)}`);
  }
  return page.ready;
}

export interface ConnectFakePageOptions {
  port: number;
  /**
   * `get_pairing_code` 下发的原文。复合 token（`<port>.<secret>`）与老格式裸 secret
   * 都接受——内部按真实页面的做法解析后**只用 secret 段**算 mac。
   */
  pairingCode: string;
  origin?: string;
  tools?: PageToolDefinition[];
  autoInitialize?: boolean;
  /** 故意用错误的 mac，用于验证 AUTH_FAILED 路径 */
  badMac?: boolean;
}

/**
 * 冒充页面：连 WS、完成挑战-响应握手（challenge → auth）、应答 bridge 的 initialize。
 */
export async function connectFakePage(
  options: ConnectFakePageOptions,
): Promise<FakePage> {
  const {
    port,
    pairingCode,
    origin = 'https://alidocs.dingtalk.com',
    tools = [
      {
        name: 'read_document',
        description: 'read',
        inputSchema: { type: 'object' },
      },
    ],
    autoInitialize = true,
    badMac = false,
  } = options;

  // 与真实页面同构：HMAC 只对 secret 段计算（S10 / INV-1）。
  // 整串复合 token 传进 computeMac 会得到一个对不上的 mac，表现为 AUTH_FAILED——
  // 和「连到了错误的桥」现象完全一样，是本改动最容易被误诊的失败模式。
  const { secret } = parsePairingCode(pairingCode);

  const client = await connectWs({ port, origin });
  /** 收到的 JSON-RPC 消息；与返回值共享同一引用，供调用方观察 */
  const requests: HostMessage[] = [];

  let resolveDone: (value: PageHandshakeResult) => void = () => {};
  const handshakeDone = new Promise<PageHandshakeResult>((resolve) => {
    resolveDone = resolve;
  });

  // 先装 handler 再补投缓冲：bridge accept 后**主动**发 challenge（server-initiated），
  // 可能在 connectWs 返回后、onmessage 装配前就到达并被缓冲。
  // （真实页面 transport 在 open 前同步装 onmessage，无此竞态；仅测试辅助需处理）
  client.onmessage = (text: string) => {
    const message = JSON.parse(text) as HostMessage & {
      docmcp?: number;
      type?: string;
      nonce?: string;
    };
    if (message.docmcp) {
      if (message.type === CONTROL_TYPE.CHALLENGE) {
        const mac = badMac
          ? 'f'.repeat(64)
          : computeMac(secret, message.nonce ?? '');
        client.sendJson({
          docmcp: PROTOCOL_VERSION,
          type: CONTROL_TYPE.AUTH,
          mac,
          client: {
            name: 'page-client',
            version: 'test',
            toolCount: tools.length,
          },
        });
        return;
      }
      // ready 或 error
      resolveDone(message as unknown as PageHandshakeResult);
      return;
    }
    requests.push(message);
    if (!autoInitialize) return;
    if (message.method === 'initialize') {
      client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
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

  const ready = await handshakeDone;
  return { client, ready, tools, requests };
}

/** 等待条件成立（轮询），用于观察异步状态 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label = 'condition',
  timeoutMs = 3000,
): Promise<true> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- 轮询语义要求顺序等待
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时: ${label}`);
}
