/**
 * 线协议 · 单一真源
 *
 * 本文件是 bridge 与页面侧两侧共同遵循的协议定义，**零运行时依赖**。
 * 页面侧有一份等价的 TS 镜像实现；两侧均断言与 `vectors.json` 逐字一致，防止 drift。
 *
 * ── 版本协商（v3+，见 docs/rfc-versioning-and-dynamic-tools.md）──
 *   wire 协议是「带兼容窗口的语义化版本」：桥声明支持区间 [PROTOCOL_MIN, PROTOCOL_MAX]。
 *   INV-1（发布顺序不变式）：**桥的 npm 包永远先于页面发布协议版本**，故
 *   「页面比桥旧」是灰度常态 → 静默向下协商；「页面比桥新」只可能因用户本地桥过旧
 *   → 回 PROTOCOL_MISMATCH，唯一补救是升级桥。
 *
 * ── 握手（挑战-响应，secret 永不上线）──
 *   page → bridge:  OPEN(ws://127.0.0.1:<port>)                       # bridge 校验 Origin 白名单
 *   bridge → page:  { docmcp:PROTOCOL_MIN, type:'challenge', nonce,   # docmcp 取最低版本，保证老页面可读
 *                     protocolMin, protocolMax, bridgeVersion }        # 携带桥支持区间供页面协商
 *   page → bridge:  { docmcp, type:'auth', mac, client }              # client 可带 protocolMin/Max/连接器版本/caps
 *   bridge 校验 mac → 协商版本：
 *      通过且有交集 → { docmcp:negotiated, type:'ready', sessionId, allowWrite, version, protocol }
 *      通过但无交集 → { type:'error', code:'PROTOCOL_MISMATCH', message } + close 4004（桥过旧，请升级桥）
 *      mac 失败      → { type:'error', code:'AUTH_FAILED', message } + close 4003
 *   page → bridge:  { docmcp, type:'bye' }                            # 主动断开
 *
 * ── 握手完成后 ──
 *   双向原样透传 JSON-RPC（bridge 是哑管道，不理解工具语义）。
 *
 * secret 即「配对码」：CLI 用 CSPRNG 生成、经带外/数据通道交付页面，
 * 页面存 sessionStorage 用于刷新后重连；全程只发 HMAC，明文不上线。
 */

/**
 * wire 协议版本。破坏性变更才 +1；加法式变更用能力标志声明、不加版本。
 * - `PROTOCOL_MAX`：桥支持的最高版本（= 当前版本）。
 * - `PROTOCOL_MIN`：桥支持的最低版本；必须 ≥ 线上仍存活的最老页面版本才可上抬（窗口策略）。
 * - `PROTOCOL_VERSION`：历史别名，等于 `PROTOCOL_MAX`，供旧引用与 vectors 使用。
 */
export const PROTOCOL_MIN = 2;
export const PROTOCOL_MAX = 3;
export const PROTOCOL_VERSION = PROTOCOL_MAX;

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
  PROTOCOL_MISMATCH: 4004,
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

/**
 * 页面在 auth 帧里自报的身份与能力清单（仅用于诊断/审计/协商，不参与鉴权）。
 *
 * `protocolMin`/`protocolMax` 是页面支持的 wire 协议区间；桥据此与自身区间取交集协商。
 * `connectorVersion`/`editorVersion`/`gray` 用于诊断「连的是哪个灰度桶的哪个连接器」。
 */
export interface ClientInfo {
  name?: string;
  version?: string;
  docId?: string;
  readOnly?: boolean;
  toolCount?: number;
  /** 页面支持的 wire 协议区间下界（缺省视为 PROTOCOL_MIN） */
  protocolMin?: number;
  /** 页面支持的 wire 协议区间上界（缺省视为该帧 docmcp） */
  protocolMax?: number;
  /** 页面选定的协议版本（诊断用；真正生效值以桥协商结果为准） */
  protocol?: number;
  /** 连接器（页面内 MCP 连接器）版本 */
  connectorVersion?: string;
  /** 编辑器 / 宿主应用版本 */
  editorVersion?: string;
  /** 页面能力标志（加法式特性开关） */
  caps?: string[];
  /** 灰度桶标识（诊断用） */
  gray?: string;
  [key: string]: unknown;
}

export interface ChallengeMessage {
  docmcp: number;
  type: typeof CONTROL_TYPE.CHALLENGE;
  nonce: string;
  /** 桥支持的 wire 协议区间（供页面协商） */
  protocolMin: number;
  protocolMax: number;
  /** 桥软件版本（诊断用） */
  bridgeVersion?: string;
  /** 桥能力标志 */
  caps?: string[];
}

export interface AuthMessage {
  docmcp: number;
  type: typeof CONTROL_TYPE.AUTH;
  mac: string;
  client: ClientInfo;
}

export interface ReadyMessage {
  docmcp: number;
  type: typeof CONTROL_TYPE.READY;
  sessionId: string;
  allowWrite: boolean;
  version: string;
  /** 协商生效的 wire 协议版本 */
  protocol: number;
  /** 桥能力标志 */
  caps?: string[];
}

export interface ErrorMessage {
  docmcp: number;
  type: typeof CONTROL_TYPE.ERROR;
  code: string;
  message: string;
}

export interface ByeMessage {
  docmcp: number;
  type: typeof CONTROL_TYPE.BYE;
}

export type ControlMessage =
  | ChallengeMessage
  | AuthMessage
  | ReadyMessage
  | ErrorMessage
  | ByeMessage;

/**
 * 是否为本协议的控制消息（**区间容忍**）。
 *
 * 用宽松入参 + 类型收窄：调用方拿到的是 `unknown`（来自网络的任意 JSON），
 * 通过本函数后才可按控制消息访问字段。`docmcp` 落在 [PROTOCOL_MIN, PROTOCOL_MAX]
 * 内即视为可解析——这是 v3 相对 v2「精确等值」的关键放宽，使灰度期多版本共存可协商。
 */
export function isControlMessage(
  message: unknown,
): message is ControlMessage & Record<string, unknown> {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return (
    typeof m.docmcp === 'number' &&
    m.docmcp >= PROTOCOL_MIN &&
    m.docmcp <= PROTOCOL_MAX &&
    typeof m.type === 'string'
  );
}

/**
 * 版本协商：桥区间 [PROTOCOL_MIN, PROTOCOL_MAX] 与对端区间取交集，返回交集内最高版本；
 * 无交集返回 null（由 INV-1，无交集只可能是「桥过旧」）。
 */
export function negotiateProtocol(
  peerMin: number,
  peerMax: number,
): number | null {
  const lo = Math.max(PROTOCOL_MIN, peerMin);
  const hi = Math.min(PROTOCOL_MAX, peerMax);
  return hi >= lo ? hi : null;
}

/**
 * 构造 challenge（bridge → page）。
 *
 * `docmcp` **恒取 PROTOCOL_MIN**：这是自举规则——老页面（只认最低版本）也能识别本帧，
 * 从而读到 `protocolMax` 决定是否升级。
 */
export function makeChallenge(
  nonce: string,
  opts?: { bridgeVersion?: string; caps?: string[] },
): ChallengeMessage {
  const msg: ChallengeMessage = {
    docmcp: PROTOCOL_MIN,
    type: CONTROL_TYPE.CHALLENGE,
    nonce,
    protocolMin: PROTOCOL_MIN,
    protocolMax: PROTOCOL_MAX,
  };
  if (opts?.bridgeVersion) msg.bridgeVersion = opts.bridgeVersion;
  if (opts?.caps) msg.caps = opts.caps;
  return msg;
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

/** 构造 ready（bridge → page）。`docmcp` 取协商生效版本 */
export function makeReady(fields: {
  sessionId: string;
  allowWrite?: boolean;
  version: string;
  protocol: number;
  caps?: string[];
}): ReadyMessage {
  const msg: ReadyMessage = {
    docmcp: fields.protocol,
    type: CONTROL_TYPE.READY,
    sessionId: fields.sessionId,
    allowWrite: !!fields.allowWrite,
    version: fields.version,
    protocol: fields.protocol,
  };
  if (fields.caps) msg.caps = fields.caps;
  return msg;
}

/** 构造 error（bridge → page）。`docmcp` 取最低版本，保证任一支持版本的页面都能读到 */
export function makeError(code: string, message?: string): ErrorMessage {
  return {
    docmcp: PROTOCOL_MIN,
    type: CONTROL_TYPE.ERROR,
    code,
    message: message || '',
  };
}

/** 构造 bye（page → bridge） */
export function makeBye(): ByeMessage {
  return { docmcp: PROTOCOL_VERSION, type: CONTROL_TYPE.BYE };
}
