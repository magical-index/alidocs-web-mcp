'use strict';

/**
 * 页面会话管理：挑战-响应握手（S10）+ 单连接会话制（S8）。
 *
 * 握手时序（详见 protocol.js）：
 *   accept(conn) → bridge 发 challenge{nonce} → 页面回 auth{mac} →
 *   校验 HMAC(secret, nonce) → ready{sessionId} 或 error+close(4003)
 *
 * 握手完成后 JSON-RPC 原样透传，bridge 不理解工具语义。
 * secret 永不上线，只校验页面回传的 mac；旧密钥（rotate 后）自然失效。
 */

const {
  PROTOCOL_VERSION,
  CLOSE_CODE,
  CONTROL_TYPE,
  ERROR_CODE,
  isControlMessage,
  makeChallenge,
  makeReady,
  makeError,
} = require('./protocol');
const { generateNonce } = require('./protocol/crypto');

class PageSessionManager {
  /**
   * @param {{
   *   secretStore: { verify: (nonce: string, mac: unknown) => boolean },
   *   handshakeTimeoutMs: number,
   *   version: string,
   *   allowWrite: boolean,
   *   audit?: { write: (event: string, fields?: object) => void },
   *   makeNonce?: () => string,
   * }} options
   */
  constructor(options) {
    this.secretStore = options.secretStore;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.version = options.version;
    this.allowWrite = options.allowWrite;
    this.audit = options.audit || null;
    this.makeNonce = options.makeNonce || generateNonce;

    this.sessionCounter = 0;
    /** @type {null | { id: string, origin: string, client: object, startedAt: number, connection: object }} */
    this.current = null;

    this.onSessionOpen = null;
    this.onSessionClose = null;
    this.onJsonRpc = null;
  }

  get connected() {
    return !!this.current;
  }

  /** 接管一条已完成 WS upgrade 的连接：立即下发 challenge，进入握手等待态 */
  accept(connection) {
    const nonce = this.makeNonce();
    const pending = {
      connection,
      nonce,
      handshaken: false,
      session: null,
    };

    const timer = setTimeout(() => {
      if (pending.handshaken) return;
      this.auditWrite('session.handshake.timeout', { origin: connection.origin });
      connection.close(CLOSE_CODE.HANDSHAKE_TIMEOUT, 'handshake timeout');
    }, this.handshakeTimeoutMs);
    if (timer.unref) timer.unref();

    connection.onmessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        if (!pending.handshaken) {
          connection.close(CLOSE_CODE.MALFORMED, 'invalid json');
        } else {
          this.auditWrite('session.message.malformed', {
            sessionId: pending.session && pending.session.id,
          });
        }
        return;
      }

      if (!pending.handshaken) {
        clearTimeout(timer);
        this.handleAuth(pending, message);
        return;
      }

      if (isControlMessage(message)) {
        this.handleControl(pending, message);
        return;
      }

      if (this.onJsonRpc && this.current === pending.session) {
        this.onJsonRpc(message, pending.session);
      }
    };

    connection.onclose = (info) => {
      clearTimeout(timer);
      const session = pending.session;
      if (!session) return;
      if (this.current !== session) return; // 已被顶掉的旧连接不再冒泡
      this.current = null;
      this.auditWrite('session.close', {
        sessionId: session.id,
        origin: session.origin,
        code: info && info.code,
      });
      if (this.onSessionClose) this.onSessionClose(session, info || {});
    };

    connection.onerror = (error) => {
      this.auditWrite('session.error', {
        sessionId: pending.session && pending.session.id,
        message: error && error.message,
      });
    };

    // 主动下发 challenge（页面 onopen 后即可收到）
    this.sendControl(connection, makeChallenge(nonce));
  }

  /** 校验 auth{mac}：HMAC(secret, nonce) 通过则建会话 */
  handleAuth(pending, message) {
    const { connection, nonce } = pending;
    if (
      !isControlMessage(message) ||
      message.type !== CONTROL_TYPE.AUTH ||
      typeof message.mac !== 'string'
    ) {
      this.sendControl(
        connection,
        makeError(ERROR_CODE.BAD_MESSAGE, '首帧必须是 auth{ mac }'),
      );
      connection.close(CLOSE_CODE.AUTH_FAILED, 'bad auth');
      return;
    }

    if (!this.secretStore.verify(nonce, message.mac)) {
      this.auditWrite('session.auth.failed', { origin: connection.origin });
      this.sendControl(
        connection,
        makeError(
          ERROR_CODE.AUTH_FAILED,
          '配对失败：mac 不匹配（配对码错误/已撤销/已轮换），请重新配对',
        ),
      );
      connection.close(CLOSE_CODE.AUTH_FAILED, ERROR_CODE.AUTH_FAILED);
      return;
    }

    // S8 单连接会话制：新会话顶掉旧会话
    if (this.current) {
      const previous = this.current;
      this.current = null;
      this.auditWrite('session.superseded', { sessionId: previous.id });
      previous.connection.close(CLOSE_CODE.SUPERSEDED, 'superseded by new session');
      if (this.onSessionClose) {
        this.onSessionClose(previous, {
          code: CLOSE_CODE.SUPERSEDED,
          reason: 'superseded',
        });
      }
    }

    const session = {
      id: `s${++this.sessionCounter}`,
      origin: connection.origin,
      client: sanitizeClientInfo(message.client),
      startedAt: Date.now(),
      connection,
    };
    pending.handshaken = true;
    pending.session = session;
    this.current = session;

    this.auditWrite('session.open', {
      sessionId: session.id,
      origin: session.origin,
      client: session.client,
    });

    this.sendControl(
      connection,
      makeReady({
        sessionId: session.id,
        allowWrite: this.allowWrite,
        version: this.version,
      }),
    );

    if (this.onSessionOpen) this.onSessionOpen(session);
  }

  /** 握手后的控制消息 */
  handleControl(pending, message) {
    if (message.type === CONTROL_TYPE.BYE) {
      pending.connection.close(CLOSE_CODE.NORMAL, 'bye');
    }
    // 其余控制类型 v1 忽略（向前兼容）
  }

  /**
   * 向当前会话发送 JSON-RPC。
   * @returns {boolean} 是否送出
   */
  sendJsonRpc(message) {
    if (!this.current) return false;
    this.current.connection.send(JSON.stringify(message));
    return true;
  }

  sendControl(connection, payload) {
    connection.send(JSON.stringify(payload));
  }

  /** 主动关闭当前会话 */
  closeCurrent(code, reason) {
    if (!this.current) return;
    this.current.connection.close(code || CLOSE_CODE.NORMAL, reason || '');
  }

  auditWrite(event, fields) {
    if (this.audit) this.audit.write(event, fields);
  }
}

/** 只保留客户端自报信息中的白名单字段，避免任意数据进日志 */
function sanitizeClientInfo(client) {
  if (!client || typeof client !== 'object') return {};
  const pick = ['name', 'version', 'href', 'docId', 'readOnly', 'toolCount', 'context'];
  const result = {};
  for (const key of pick) {
    const value = client[key];
    if (typeof value === 'string') result[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

module.exports = {
  PageSessionManager,
  DOCMCP_PROTOCOL: PROTOCOL_VERSION,
  CLOSE_CODE,
  sanitizeClientInfo,
};
