/**
 * 页面会话管理：挑战-响应握手（S10）+ 单连接会话制（S8）。
 *
 * 握手时序（详见 protocol/index.ts）：
 *   accept(conn) → bridge 发 challenge{nonce} → 页面回 auth{mac} →
 *   校验 HMAC(secret, nonce) → ready{sessionId} 或 error + close(4003)
 *
 * 握手完成前**不接受任何业务消息**：首帧必须是 auth，否则直接关闭。
 * 握手完成后 JSON-RPC 原样透传，bridge 不理解工具语义。
 * secret 永不上线，只校验页面回传的 mac；rotate 后旧密钥自然失效。
 */

import {
  PROTOCOL_VERSION,
  PROTOCOL_MIN,
  PROTOCOL_MAX,
  CLOSE_CODE,
  CONTROL_TYPE,
  ERROR_CODE,
  isControlMessage,
  negotiateProtocol,
  makeChallenge,
  makeReady,
  makeError,
} from './protocol/index.js';
import { generateNonce } from './protocol/crypto.js';

/** WS 连接抽象：由 wsServer 提供，便于测试替换 */
export interface SessionConnection {
  origin: string;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((text: string) => void) | null;
  onclose: ((info: { code?: number; reason?: string }) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface ClientSummary {
  [key: string]: string | number | boolean;
}

export interface PageSession {
  id: string;
  origin: string;
  client: ClientSummary;
  /** 协商生效的 wire 协议版本 */
  protocol: number;
  startedAt: number;
  connection: SessionConnection;
}

interface PendingHandshake {
  connection: SessionConnection;
  nonce: string;
  handshaken: boolean;
  session: PageSession | null;
}

export interface PageSessionManagerOptions {
  secretStore: { verify: (nonce: string, mac: unknown) => boolean };
  handshakeTimeoutMs: number;
  version: string;
  allowWrite: boolean;
  audit?: {
    write: (event: string, fields?: Record<string, unknown>) => void;
  } | null;
  makeNonce?: () => string;
}

export class PageSessionManager {
  private readonly secretStore: PageSessionManagerOptions['secretStore'];

  private readonly handshakeTimeoutMs: number;

  private readonly version: string;

  private readonly allowWrite: boolean;

  private readonly audit: PageSessionManagerOptions['audit'];

  private readonly makeNonce: () => string;

  private sessionCounter = 0;

  current: PageSession | null = null;

  onSessionOpen: ((session: PageSession) => void) | null = null;

  onSessionClose:
    | ((session: PageSession, info: { code?: number; reason?: string }) => void)
    | null = null;

  onJsonRpc: ((message: unknown, session: PageSession) => void) | null = null;

  constructor(options: PageSessionManagerOptions) {
    this.secretStore = options.secretStore;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs;
    this.version = options.version;
    this.allowWrite = options.allowWrite;
    this.audit = options.audit ?? null;
    this.makeNonce = options.makeNonce ?? generateNonce;
  }

  get connected(): boolean {
    return !!this.current;
  }

  /** 接管一条已完成 WS upgrade 的连接：立即下发 challenge，进入握手等待态 */
  accept(connection: SessionConnection): void {
    const nonce = this.makeNonce();
    const pending: PendingHandshake = {
      connection,
      nonce,
      handshaken: false,
      session: null,
    };

    const timer = setTimeout(() => {
      if (pending.handshaken) return;
      this.auditWrite('session.handshake.timeout', {
        origin: connection.origin,
      });
      connection.close(CLOSE_CODE.HANDSHAKE_TIMEOUT, 'handshake timeout');
    }, this.handshakeTimeoutMs);
    if (timer.unref) timer.unref();

    connection.onmessage = (text: string) => {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        if (!pending.handshaken) {
          connection.close(CLOSE_CODE.MALFORMED, 'invalid json');
        } else {
          this.auditWrite('session.message.malformed', {
            sessionId: pending.session?.id,
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

      if (
        this.onJsonRpc &&
        pending.session &&
        this.current === pending.session
      ) {
        this.onJsonRpc(message, pending.session);
      }
    };

    connection.onclose = (info) => {
      clearTimeout(timer);
      const { session } = pending;
      if (!session) return;
      if (this.current !== session) return; // 已被顶掉的旧连接不再冒泡
      this.current = null;
      this.auditWrite('session.close', {
        sessionId: session.id,
        origin: session.origin,
        code: info?.code,
      });
      if (this.onSessionClose) this.onSessionClose(session, info || {});
    };

    connection.onerror = (error: Error) => {
      this.auditWrite('session.error', {
        sessionId: pending.session?.id,
        message: error?.message,
      });
    };

    // 主动下发 challenge（页面 onopen 后即可收到），携带桥支持区间供页面协商
    this.sendControl(
      connection,
      makeChallenge(nonce, { bridgeVersion: this.version }),
    );
  }

  /** 校验 auth{mac}：HMAC(secret, nonce) 通过则协商版本、建会话 */
  private handleAuth(pending: PendingHandshake, message: unknown): void {
    const { connection, nonce } = pending;
    // 首帧宽松解析：只要形如 auth{ mac } 即受理（不按 docmcp 区间门控），
    // 以便对「版本超窗」的页面回结构化 PROTOCOL_MISMATCH 而非笼统 BAD_MESSAGE。
    const m =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : null;
    if (!m || m.type !== CONTROL_TYPE.AUTH || typeof m.mac !== 'string') {
      this.sendControl(
        connection,
        makeError(ERROR_CODE.BAD_MESSAGE, '首帧必须是 auth{ mac }'),
      );
      connection.close(CLOSE_CODE.AUTH_FAILED, 'bad auth');
      return;
    }

    // 先验 mac：版本诊断只暴露给持有配对码的真实页面
    if (!this.secretStore.verify(nonce, m.mac)) {
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

    // 版本协商（INV-1：页面比桥旧=常态，静默降级；无交集=桥过旧→PROTOCOL_MISMATCH）
    const client =
      m.client && typeof m.client === 'object'
        ? (m.client as Record<string, unknown>)
        : {};
    const frameVersion = typeof m.docmcp === 'number' ? m.docmcp : PROTOCOL_MIN;
    const peerMin = numberOr(client.protocolMin, PROTOCOL_MIN);
    const peerMax = numberOr(client.protocolMax, frameVersion);
    const negotiated = negotiateProtocol(peerMin, peerMax);
    if (negotiated === null) {
      this.auditWrite('session.protocol.mismatch', {
        origin: connection.origin,
        peerMin,
        peerMax,
        bridgeMin: PROTOCOL_MIN,
        bridgeMax: PROTOCOL_MAX,
      });
      this.sendControl(
        connection,
        makeError(
          ERROR_CODE.PROTOCOL_MISMATCH,
          `页面协议区间 [${peerMin},${peerMax}] 与本桥 [${PROTOCOL_MIN},${PROTOCOL_MAX}] 无交集；` +
            '本地桥过旧，请升级：npx -y @magical-index/alidocs-web-mcp@latest',
        ),
      );
      connection.close(
        CLOSE_CODE.PROTOCOL_MISMATCH,
        ERROR_CODE.PROTOCOL_MISMATCH,
      );
      return;
    }

    // S8 单连接会话制：新会话顶掉旧会话
    if (this.current) {
      const previous = this.current;
      this.current = null;
      this.auditWrite('session.superseded', { sessionId: previous.id });
      previous.connection.close(
        CLOSE_CODE.SUPERSEDED,
        'superseded by new session',
      );
      if (this.onSessionClose) {
        this.onSessionClose(previous, {
          code: CLOSE_CODE.SUPERSEDED,
          reason: 'superseded',
        });
      }
    }

    this.sessionCounter += 1;
    const session: PageSession = {
      id: `s${this.sessionCounter}`,
      origin: connection.origin,
      client: sanitizeClientInfo(client),
      protocol: negotiated,
      startedAt: Date.now(),
      connection,
    };
    pending.handshaken = true;
    pending.session = session;
    this.current = session;

    this.auditWrite('session.open', {
      sessionId: session.id,
      origin: session.origin,
      protocol: negotiated,
      client: session.client,
    });

    this.sendControl(
      connection,
      makeReady({
        sessionId: session.id,
        allowWrite: this.allowWrite,
        version: this.version,
        protocol: negotiated,
      }),
    );

    if (this.onSessionOpen) this.onSessionOpen(session);
  }

  /** 握手后的控制消息 */
  private handleControl(
    pending: PendingHandshake,
    message: { type: string },
  ): void {
    if (message.type === CONTROL_TYPE.BYE) {
      pending.connection.close(CLOSE_CODE.NORMAL, 'bye');
    }
    // 其余控制类型 v1 忽略（向前兼容）
  }

  /** 向当前会话发送 JSON-RPC；返回是否送出 */
  sendJsonRpc(message: unknown): boolean {
    if (!this.current) return false;
    this.current.connection.send(JSON.stringify(message));
    return true;
  }

  sendControl(connection: SessionConnection, payload: unknown): void {
    connection.send(JSON.stringify(payload));
  }

  /** 主动关闭当前会话 */
  closeCurrent(code?: number, reason?: string): void {
    if (!this.current) return;
    this.current.connection.close(code || CLOSE_CODE.NORMAL, reason || '');
  }

  private auditWrite(event: string, fields?: Record<string, unknown>): void {
    if (this.audit) this.audit.write(event, fields);
  }
}

/** 只保留客户端自报信息中的白名单字段，避免任意数据进日志 */
export function sanitizeClientInfo(client: unknown): ClientSummary {
  if (!client || typeof client !== 'object') return {};
  const source = client as Record<string, unknown>;
  const pick = [
    'name',
    'version',
    'href',
    'docId',
    'readOnly',
    'toolCount',
    'context',
    // v3 能力清单（诊断用）：连接器/编辑器版本、协商版本、灰度桶
    'connectorVersion',
    'editorVersion',
    'protocol',
    'gray',
  ];
  const result: ClientSummary = {};
  for (const key of pick) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  // caps 是字符串数组，折叠成逗号串以适配 ClientSummary 的原始类型
  if (Array.isArray(source.caps)) {
    const caps = source.caps
      .filter((c): c is string => typeof c === 'string')
      .slice(0, 32)
      .join(',');
    if (caps) result.caps = caps.slice(0, 200);
  }
  return result;
}

/** 取数字，非数字回退到默认值 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export { CLOSE_CODE };
export const DOCMCP_PROTOCOL = PROTOCOL_VERSION;
