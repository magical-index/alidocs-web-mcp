/**
 * 零依赖 WebSocket 测试客户端（net + 帧编解码）。
 *
 * 作为**公开 API** 提供：下游（页面侧实现）可用它对真实 bridge 进程做契约测试，
 * 而不必各自 mock —— 各自 mock 会形成"契约幻觉"，两端都以为自己对。
 */

import * as net from 'node:net';
import * as crypto from 'node:crypto';
import {
  OPCODE,
  encodeText,
  encodeClose,
  createFrameParser,
  type FrameParser,
} from '../frames.js';

export interface WsCloseInfo {
  code: number;
  reason: string;
}

interface MessageWaiter {
  index: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** 已建立的测试连接：暴露原始文本收发与等待原语 */
export class TestWsClient {
  readonly parser: FrameParser;

  /** 收到的原始文本消息（未解析） */
  readonly messages: string[] = [];

  closeInfo: WsCloseInfo | null = null;

  onmessage: ((text: string) => void) | null = null;

  onclose: ((info: WsCloseInfo) => void) | null = null;

  private readonly socket: net.Socket;

  private waiters: MessageWaiter[] = [];

  private readIndex = 0;

  constructor(socket: net.Socket) {
    this.socket = socket;

    this.parser = createFrameParser({
      requireMask: false,
      onMessage: ({ opcode, payload }) => {
        if (opcode !== OPCODE.TEXT) return;
        const text = payload.toString('utf8');
        this.messages.push(text);
        if (this.onmessage) this.onmessage(text);
        this.flushWaiters();
      },
      onClose: (info) => this.finish(info),
      onPing: () => {},
      onPong: () => {},
      onError: () => this.finish({ code: 1002, reason: 'frame error' }),
    });

    socket.on('data', (chunk: Buffer) => this.parser.push(chunk));
    socket.on('close', () =>
      this.finish({ code: 1006, reason: 'socket closed' }),
    );
    socket.on('error', () =>
      this.finish({ code: 1006, reason: 'socket error' }),
    );
  }

  private finish(info: WsCloseInfo): void {
    if (this.closeInfo) return;
    this.closeInfo = info;
    if (this.onclose) this.onclose(info);
    this.flushWaiters();
  }

  private flushWaiters(): void {
    for (const waiter of this.waiters.slice()) {
      const arrived = this.messages[waiter.index];
      if (arrived !== undefined) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(arrived);
      } else if (this.closeInfo) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `连接已关闭(code=${this.closeInfo.code})，等不到第 ${waiter.index + 1} 条消息`,
          ),
        );
      }
    }
  }

  /** 等待第 index 条消息（0 基），已到达则立即返回 */
  waitMessage(index: number, timeoutMs = 3000): Promise<string> {
    const existing = this.messages[index];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<string>((resolve, reject) => {
      const waiter: MessageWaiter = { index, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待第 ${index + 1} 条消息超时`));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.flushWaiters();
    });
  }

  /** 等待下一条 JSON 消息并解析（按到达顺序游标推进） */
  async nextJson<T = unknown>(timeoutMs?: number): Promise<T> {
    const index = this.readIndex;
    this.readIndex = index + 1;
    return JSON.parse(await this.waitMessage(index, timeoutMs)) as T;
  }

  send(text: string): void {
    this.socket.write(encodeText(text, { mask: true }));
  }

  sendJson(value: unknown): void {
    this.send(JSON.stringify(value));
  }

  close(code = 1000, reason = ''): void {
    this.socket.write(encodeClose(code, reason, { mask: true }));
    this.socket.destroy();
  }

  /** 等待连接关闭并返回关闭信息 */
  waitClose(timeoutMs = 3000): Promise<WsCloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise<WsCloseInfo>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('等待关闭超时')),
        timeoutMs,
      );
      this.onclose = (info) => {
        clearTimeout(timer);
        resolve(info);
      };
    });
  }
}

/** upgrade 被拒时抛出的错误，带状态码与桥给出的拒绝原因 */
export interface WsUpgradeError extends Error {
  status?: number;
  rejectReason?: string | null;
}

export interface ConnectWsOptions {
  port: number;
  origin?: string;
  host?: string;
  timeoutMs?: number;
}

/**
 * 发起 WS 连接。
 *
 * upgrade 非 101 时 reject，错误上带 `status` 与 `rejectReason`
 * （后者取自桥的 `X-Docmcp-Reject` 头，便于断言被拒的具体原因）。
 */
export function connectWs(options: ConnectWsOptions): Promise<TestWsClient> {
  const { port, origin, host = '127.0.0.1', timeoutMs = 3000 } = options;
  return new Promise<TestWsClient>((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WS upgrade 超时'));
    }, timeoutMs);

    let raw = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      raw = Buffer.concat([raw, chunk]);
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) return;

      const head = raw.subarray(0, separator).toString('utf8');
      const rest = raw.subarray(separator + 4);
      socket.removeListener('data', onData);
      clearTimeout(timer);

      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 101) {
        socket.destroy();
        const error: WsUpgradeError = new Error(`upgrade 被拒: ${status}`);
        error.status = status;
        const match = /X-Docmcp-Reject:\s*(\S+)/i.exec(head);
        error.rejectReason = match ? (match[1] ?? null) : null;
        reject(error);
        return;
      }

      const client = new TestWsClient(socket);
      if (rest.length) client.parser.push(rest);
      resolve(client);
    };

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', onData);
    socket.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const lines = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  });
}
