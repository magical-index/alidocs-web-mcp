'use strict';

/**
 * 测试用最小 WebSocket 客户端（零依赖，复用 src/frames.js 的编解码）。
 *
 * 只做 bridge 测试需要的事：带自定义 Origin 发起 upgrade、收发文本帧、观察关闭码。
 */

const net = require('net');
const crypto = require('crypto');
const { OPCODE, encodeText, encodeClose, createFrameParser } = require('../../src/frames');

class TestWsClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.closeInfo = null;
    this.onmessage = null;
    this.onclose = null;
    this.waiters = [];

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

    socket.on('data', (chunk) => this.parser.push(chunk));
    socket.on('close', () => this.finish({ code: 1006, reason: 'socket closed' }));
    socket.on('error', () => this.finish({ code: 1006, reason: 'socket error' }));
  }

  finish(info) {
    if (this.closeInfo) return;
    this.closeInfo = info;
    if (this.onclose) this.onclose(info);
    this.flushWaiters();
  }

  flushWaiters() {
    for (const waiter of this.waiters.slice()) {
      if (this.messages.length > waiter.index) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(this.messages[waiter.index]);
      } else if (this.closeInfo) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(`连接已关闭(code=${this.closeInfo.code})，等不到第 ${waiter.index + 1} 条消息`),
        );
      }
    }
  }

  /** 等待第 index 条消息（0 基），已到达则立即返回 */
  waitMessage(index, timeoutMs = 3000) {
    if (this.messages.length > index) return Promise.resolve(this.messages[index]);
    return new Promise((resolve, reject) => {
      const waiter = { index, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待第 ${index + 1} 条消息超时`));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.flushWaiters();
    });
  }

  /** 等待下一条 JSON 消息并解析 */
  async nextJson(timeoutMs) {
    const index = this.readIndex === undefined ? 0 : this.readIndex;
    this.readIndex = index + 1;
    return JSON.parse(await this.waitMessage(index, timeoutMs));
  }

  send(text) {
    this.socket.write(encodeText(text, { mask: true }));
  }

  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  close(code = 1000, reason = '') {
    this.socket.write(encodeClose(code, reason, { mask: true }));
    this.socket.destroy();
  }

  /** 等待连接关闭并返回关闭信息 */
  waitClose(timeoutMs = 3000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
      this.onclose = (info) => {
        clearTimeout(timer);
        resolve(info);
      };
    });
  }
}

/**
 * 发起 WS 连接。
 *
 * @param {{ port: number, origin?: string, host?: string, timeoutMs?: number }} options
 * @returns {Promise<TestWsClient>} upgrade 非 101 时 reject（error.status 为状态码）
 */
function connectWs(options) {
  const { port, origin, host = '127.0.0.1', timeoutMs = 3000 } = options;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WS upgrade 超时'));
    }, timeoutMs);

    let raw = Buffer.alloc(0);

    const onData = (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) return;

      const head = raw.subarray(0, separator).toString('utf8');
      const rest = raw.subarray(separator + 4);
      socket.removeListener('data', onData);
      clearTimeout(timer);

      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      if (status !== 101) {
        socket.destroy();
        const error = new Error(`upgrade 被拒: ${status}`);
        error.status = status;
        const match = /X-Docmcp-Reject:\s*(\S+)/i.exec(head);
        error.rejectReason = match ? match[1] : null;
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

module.exports = { connectWs, TestWsClient };
