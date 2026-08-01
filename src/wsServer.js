'use strict';

/**
 * 零依赖 WebSocket 服务端（仅 bridge 所需子集）。
 *
 * 安全职责：
 * - 只 bind 127.0.0.1（S1）
 * - upgrade 阶段校验 Origin 白名单，不通过直接 403（S2）
 * - 提供 /healthz 诊断端点，供页面区分「端口未开 / Origin 被拒 / 升级失败」（S7）
 *   端点只暴露端口、版本、originAllowed、connected，**不含 token 与文档信息**
 * - 预留 PNA preflight 响应头（Access-Control-Allow-Private-Network），
 *   以便内核收紧本地网络访问后仍可放行（S7）
 */

const http = require('http');
const crypto = require('crypto');
const { isOriginAllowed } = require('./config');
const { SERVICE_ID } = require('./protocol/index');
const {
  OPCODE,
  encodeText,
  encodeClose,
  encodeFrame,
  createFrameParser,
} = require('./frames');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 心跳间隔：连续 2 次无 pong 视为死连接 */
const PING_INTERVAL_MS = 30 * 1000;

/** 计算 Sec-WebSocket-Accept */
function computeAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}${WS_GUID}`)
    .digest('base64');
}

/**
 * 已完成 upgrade 的连接包装：只暴露文本收发与关闭。
 */
class WsConnection {
  /**
   * @param {import('net').Socket} socket
   * @param {{ origin: string }} info
   */
  constructor(socket, info) {
    this.socket = socket;
    this.origin = info.origin;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.awaitingPong = false;

    this.parser = createFrameParser({
      requireMask: true,
      onMessage: ({ opcode, payload }) => {
        if (opcode !== OPCODE.TEXT) {
          // v1 只使用文本帧承载 JSON-RPC
          this.close(1003, 'binary frames unsupported');
          return;
        }
        if (this.onmessage) this.onmessage(payload.toString('utf8'));
      },
      onClose: ({ code, reason }) => {
        this.finish(code, reason);
      },
      onPing: (payload) => {
        this.writeRaw(encodeFrame(OPCODE.PONG, payload));
      },
      onPong: () => {
        this.awaitingPong = false;
      },
      onError: (error) => {
        if (this.onerror) this.onerror(error);
        this.close(error.closeCode || 1002, 'protocol error');
      },
    });

    socket.on('data', (chunk) => this.parser.push(chunk));
    socket.on('error', (error) => {
      if (this.onerror) this.onerror(error);
      this.finish(1006, 'socket error');
    });
    socket.on('close', () => this.finish(1006, 'socket closed'));

    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (this.awaitingPong) {
        this.close(1001, 'ping timeout');
        return;
      }
      this.awaitingPong = true;
      this.writeRaw(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
    }, PING_INTERVAL_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  writeRaw(buffer) {
    if (this.closed) return;
    try {
      this.socket.write(buffer);
    } catch (error) {
      if (this.onerror) this.onerror(error);
    }
  }

  /** 发送一条文本消息 */
  send(text) {
    this.writeRaw(encodeText(text));
  }

  /** 主动关闭（发送 close 帧后销毁 socket） */
  close(code, reason) {
    if (this.closed) {
      return;
    }
    try {
      this.socket.write(encodeClose(code || 1000, reason || ''));
    } catch {
      // 忽略：socket 可能已不可写
    }
    this.finish(code || 1000, reason || '');
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      this.socket.destroy();
    } catch {
      // 忽略
    }
    if (this.onclose) this.onclose({ code, reason });
  }
}

/**
 * 创建 WS server。
 *
 * @param {{
 *   host: string,
 *   portCandidates: number[],
 *   allowedOrigins: string[],
 *   version: string,
 *   audit?: { write: (event: string, fields?: object) => void },
 *   getStatus?: () => object,
 *   onConnection: (connection: WsConnection) => void,
 * }} options
 */
function createWsServer(options) {
  const {
    host,
    portCandidates,
    allowedOrigins,
    version,
    audit,
    getStatus,
    onConnection,
  } = options;

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const originAllowed = isOriginAllowed(origin, allowedOrigins);
    const url = (req.url || '').split('?')[0];

    // CORS + PNA：ACAO 回具体来源（非 *），Vary: Origin（security §4.1）
    const headers = {
      'Access-Control-Allow-Origin': origin || 'null',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Headers': 'content-type',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (url === '/health' || url === '/healthz') {
      // Origin 分级（security §4.1）：
      // - 白名单内：返回诊断所需字段
      // - 白名单外：仅够页面区分「桥在但我被拒」，不泄露 connected/allowWrite/hookName 等指纹
      const base = { ok: true, service: SERVICE_ID, version, originAllowed };
      const body = originAllowed
        ? { ...base, ...(getStatus ? getStatus() : {}) }
        : base;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, headers);
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    const key = req.headers['sec-websocket-key'];
    const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();

    const reject = (statusLine, reasonCode) => {
      if (audit) {
        audit.write('ws.upgrade.rejected', { origin, reason: reasonCode });
      }
      try {
        socket.write(
          `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n` +
            `X-Docmcp-Reject: ${reasonCode}\r\n\r\n`,
        );
      } catch {
        // 忽略
      }
      socket.destroy();
    };

    if (upgradeHeader !== 'websocket' || !key) {
      reject('400 Bad Request', 'BAD_UPGRADE');
      return;
    }
    if (String(req.headers['sec-websocket-version']) !== '13') {
      reject('426 Upgrade Required', 'BAD_WS_VERSION');
      return;
    }
    // S2：Origin 白名单，恶意页面在此被挡住
    if (!isOriginAllowed(origin, allowedOrigins)) {
      reject('403 Forbidden', 'ORIGIN_REJECTED');
      return;
    }

    socket.setNoDelay(true);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    );

    const connection = new WsConnection(socket, { origin });
    if (head && head.length) connection.parser.push(head);
    onConnection(connection);
  });

  return {
    server,
    /**
     * 依次尝试候选端口 bind，用第一个空闲端口（S4）。
     * 全部被占用（EADDRINUSE）则抛 PORT_CONTENDED，供上层结构化诊断。
     * @returns {Promise<number>} 实际监听端口
     */
    listen() {
      const candidates =
        Array.isArray(portCandidates) && portCandidates.length
          ? portCandidates
          : [0];
      const tryPort = (index) =>
        new Promise((resolve, reject) => {
          if (index >= candidates.length) {
            const err = new Error(
              `所有候选端口被占用: ${candidates.join(', ')}`,
            );
            err.code = 'PORT_CONTENDED';
            err.candidates = candidates.slice();
            reject(err);
            return;
          }
          const candidate = candidates[index];
          const onError = (err) => {
            server.removeListener('listening', onListening);
            if (err && err.code === 'EADDRINUSE') {
              resolve(tryPort(index + 1));
            } else {
              reject(err);
            }
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidate, host);
        });
      return tryPort(0);
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createWsServer, WsConnection, computeAcceptKey, PING_INTERVAL_MS };
