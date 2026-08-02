/**
 * 线协议 · 单一真源
 *
 * 本文件是 bridge 与页面侧两侧共同遵循的协议定义，**零运行时依赖**。
 * 页面侧有一份等价的 TS 镜像实现；两侧均断言与 `vectors.json` 逐字一致，防止 drift。
 *
 * ── 握手（挑战-响应，secret 永不上线）──
 *   page → bridge:  OPEN(ws://127.0.0.1:<port>)              # bridge 校验 Origin 白名单
 *   bridge → page:  { docmcp:2, type:'challenge', nonce }
 *   page → bridge:  { docmcp:2, type:'auth', mac, client }   # mac = HMAC-SHA256(secret, nonce) hex
 *   bridge 校验 mac:
 *      通过 → { docmcp:2, type:'ready', sessionId, allowWrite, version }
 *      失败 → { docmcp:2, type:'error', code:'AUTH_FAILED', message } + close 4003
 *   page → bridge:  { docmcp:2, type:'bye' }                 # 主动断开
 *
 * ── 握手完成后 ──
 *   双向原样透传 JSON-RPC（bridge 是哑管道，不理解工具语义）。
 *
 * secret 即「配对码」：CLI 用 CSPRNG 生成、经带外/数据通道交付页面，
 * 页面存 sessionStorage 用于刷新后重连；全程只发 HMAC，明文不上线。
 */

/** 协议大版本；不兼容变更时 +1，握手时双方比对 */
export const PROTOCOL_VERSION = 2;

/**
 * 服务标识：页面侧通过 `/health` 的 `service` 字段辨认「这是本桥」，
 * 属于**发现契约**的一部分，修改需两侧同步 + 升协议版本。
 */
export const SERVICE_ID = 'alidocs-web-mcp';

/** HMAC 算法（挑战-响应），两侧必须一致 */
export const MAC_ALGORITHM = 'sha256';

/** 控制消息类型（帧内 `docmcp` 字段标识为控制消息） */
export const CONTROL_TYPE = {
  CHALLENGE: 'challenge',
  AUTH: 'auth',
  READY: 'ready',
  ERROR: 'error',
  BYE: 'bye',
} as const;

export type ControlType = (typeof CONTROL_TYPE)[keyof typeof CONTROL_TYPE];

/** WebSocket 关闭码（4xxx 为应用自定义区间） */
export const CLOSE_CODE = {
  NORMAL: 1000,
  MALFORMED: 4002,
  AUTH_FAILED: 4003,
  SUPERSEDED: 4008,
  HANDSHAKE_TIMEOUT: 4009,
} as const;

export type CloseCode = (typeof CLOSE_CODE)[keyof typeof CLOSE_CODE];

/** 握手/连接错误码（结构化诊断，S7） */
export const ERROR_CODE = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  AUTH_FAILED: 'AUTH_FAILED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  PORT_UNREACHABLE: 'PORT_UNREACHABLE',
  PORT_CONTENDED: 'PORT_CONTENDED',
  PNA_BLOCKED: 'PNA_BLOCKED',
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** 页面在 auth 帧里自报的身份（仅用于诊断与审计，不参与鉴权） */
export interface ClientInfo {
  name?: string;
  version?: string;
  docId?: string;
  readOnly?: boolean;
  toolCount?: number;
  [key: string]: unknown;
}

export interface ChallengeMessage {
  docmcp: typeof PROTOCOL_VERSION;
  type: typeof CONTROL_TYPE.CHALLENGE;
  nonce: string;
}

export interface AuthMessage {
  docmcp: typeof PROTOCOL_VERSION;
  type: typeof CONTROL_TYPE.AUTH;
  mac: string;
  client: ClientInfo;
}

export interface ReadyMessage {
  docmcp: typeof PROTOCOL_VERSION;
  type: typeof CONTROL_TYPE.READY;
  sessionId: string;
  allowWrite: boolean;
  version: string;
}

export interface ErrorMessage {
  docmcp: typeof PROTOCOL_VERSION;
  type: typeof CONTROL_TYPE.ERROR;
  code: string;
  message: string;
}

export interface ByeMessage {
  docmcp: typeof PROTOCOL_VERSION;
  type: typeof CONTROL_TYPE.BYE;
}

export type ControlMessage =
  | ChallengeMessage
  | AuthMessage
  | ReadyMessage
  | ErrorMessage
  | ByeMessage;

/**
 * 是否为本协议的控制消息。
 *
 * 用宽松入参 + 类型收窄：调用方拿到的是 `unknown`（来自网络的任意 JSON），
 * 通过本函数后才可按控制消息访问字段。
 */
export function isControlMessage(
  message: unknown,
): message is ControlMessage & Record<string, unknown> {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.docmcp === PROTOCOL_VERSION && typeof m.type === 'string';
}

/** 构造 challenge（bridge → page） */
export function makeChallenge(nonce: string): ChallengeMessage {
  return { docmcp: PROTOCOL_VERSION, type: CONTROL_TYPE.CHALLENGE, nonce };
}

/** 构造 auth（page → bridge） */
export function makeAuth(mac: string, client?: ClientInfo): AuthMessage {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.AUTH,
    mac,
    client: client || {},
  };
}

/** 构造 ready（bridge → page） */
export function makeReady(fields: {
  sessionId: string;
  allowWrite?: boolean;
  version: string;
}): ReadyMessage {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.READY,
    sessionId: fields.sessionId,
    allowWrite: !!fields.allowWrite,
    version: fields.version,
  };
}

/** 构造 error（bridge → page） */
export function makeError(code: string, message?: string): ErrorMessage {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.ERROR,
    code,
    message: message || '',
  };
}

/** 构造 bye（page → bridge） */
export function makeBye(): ByeMessage {
  return { docmcp: PROTOCOL_VERSION, type: CONTROL_TYPE.BYE };
}
