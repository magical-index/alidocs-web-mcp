'use strict';

/**
 * 线协议 · 单一真源
 *
 * 本文件是 bridge 与页面侧两侧共同遵循的协议定义，**零运行时依赖**。
 * 页面侧有一份等价的 TS 镜像实现；两侧均断言与 `vectors.json` 逐字一致，防止 drift。
 *
 * ── 握手（挑战-响应，secret 永不上线）──
 *   page → bridge:  OPEN(ws://127.0.0.1:<port>)          # bridge 校验 Origin 白名单
 *   bridge → page:  { docmcp:1, type:'challenge', nonce }
 *   page → bridge:  { docmcp:1, type:'auth', mac, client } # mac = HMAC-SHA256(secret, nonce) hex
 *   bridge 校验 mac:
 *      通过 → { docmcp:1, type:'ready', sessionId, allowWrite, version }
 *      失败 → { docmcp:1, type:'error', code:'AUTH_FAILED', message } + close 4003
 *   page → bridge:  { docmcp:1, type:'bye' }              # 主动断开
 *
 * ── 握手完成后 ──
 *   双向原样透传 JSON-RPC（bridge 是哑管道，不理解工具语义）。
 *
 * secret 即「配对码」：CLI 用 CSPRNG 生成、经带外/数据通道交付页面，
 * 页面存 sessionStorage 用于刷新后重连；全程只发 HMAC，明文不上线。
 */

/** 协议大版本；不兼容变更时 +1，握手时双方比对 */
const PROTOCOL_VERSION = 2;

/**
 * 服务标识：页面侧通过 `/health` 的 `service` 字段辨认「这是本桥」，
 * 属于**发现契约**的一部分，修改需两侧同步 + 升协议版本。
 */
const SERVICE_ID = 'alidocs-web-mcp';

/** HMAC 算法（挑战-响应），两侧必须一致 */
const MAC_ALGORITHM = 'sha256';

/** 控制消息类型（帧内 `docmcp` 字段标识为控制消息） */
const CONTROL_TYPE = {
  CHALLENGE: 'challenge',
  AUTH: 'auth',
  READY: 'ready',
  ERROR: 'error',
  BYE: 'bye',
};

/** WebSocket 关闭码（4xxx 为应用自定义区间） */
const CLOSE_CODE = {
  NORMAL: 1000,
  MALFORMED: 4002,
  AUTH_FAILED: 4003,
  SUPERSEDED: 4008,
  HANDSHAKE_TIMEOUT: 4009,
};

/** 握手/连接错误码（结构化诊断，S7） */
const ERROR_CODE = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  AUTH_FAILED: 'AUTH_FAILED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  PORT_UNREACHABLE: 'PORT_UNREACHABLE',
  PORT_CONTENDED: 'PORT_CONTENDED',
  PNA_BLOCKED: 'PNA_BLOCKED',
};

/** 是否为本协议的控制消息 */
function isControlMessage(message) {
  return (
    !!message &&
    typeof message === 'object' &&
    message.docmcp === PROTOCOL_VERSION &&
    typeof message.type === 'string'
  );
}

/** 构造 challenge（bridge → page） */
function makeChallenge(nonce) {
  return { docmcp: PROTOCOL_VERSION, type: CONTROL_TYPE.CHALLENGE, nonce };
}

/** 构造 auth（page → bridge） */
function makeAuth(mac, client) {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.AUTH,
    mac,
    client: client || {},
  };
}

/** 构造 ready（bridge → page） */
function makeReady(fields) {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.READY,
    sessionId: fields.sessionId,
    allowWrite: !!fields.allowWrite,
    version: fields.version,
  };
}

/** 构造 error（bridge → page） */
function makeError(code, message) {
  return {
    docmcp: PROTOCOL_VERSION,
    type: CONTROL_TYPE.ERROR,
    code,
    message: message || '',
  };
}

/** 构造 bye（page → bridge） */
function makeBye() {
  return { docmcp: PROTOCOL_VERSION, type: CONTROL_TYPE.BYE };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVICE_ID,
  MAC_ALGORITHM,
  CONTROL_TYPE,
  CLOSE_CODE,
  ERROR_CODE,
  isControlMessage,
  makeChallenge,
  makeAuth,
  makeReady,
  makeError,
  makeBye,
};
