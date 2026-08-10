/**
 * 配对码的复合 token 格式 `<port>.<secret>` · bridge 侧。
 *
 * 为什么把端口塞进配对码：页面在浏览器里无法 listen，只能主动去连桥；而在本改动之前
 * 页面是**按端口顺序**探候选集 [19837, 19838, 19839] 的，第一个应答的桥即胜出。
 * 多个 agent 各自 `npx` 起一个桥时，只有占住 19837 的那个可达，其余的配对码会被
 * 送到错误的桥上，握手失败并误报成 `AUTH_FAILED`。把端口写进配对码，发现就从
 * 「按端口顺序」变成「按身份」。
 *
 * 与 `crypto.ts` 同构：页面侧另有一份实现，两侧各自用 `vectors.json` 的
 * `pairingCode.cases` 校验一致性，而不是共享代码。
 *
 * S10 不变：明文只在本机数据面（agent → 页面）流动，线上永远只出现
 * `HMAC(secret, nonce)`，且 HMAC 只对 **secret 段**计算。
 */

/** 端口段与 secret 段的分隔符。secret 是 hex，结构上不含它 */
export const PAIRING_CODE_SEPARATOR = '.';

/**
 * 端口段的形状：禁前导零、最多 5 位。
 *
 * 刻意不用 `/^\d{1,5}$/`：那会把 `019837` 当成端口 1983，把页面连到**错误端口**上——
 * 比连不上更糟（连不上会报错，连错会静默串台）。
 */
export const PAIRING_CODE_PORT_PATTERN = /^[1-9][0-9]{0,4}$/;

/** 端口数值上界（正则只管形状，范围要单独判：`65536` 形状合法但不是端口） */
export const PAIRING_CODE_PORT_MAX = 65535;

/** 解析结果。`port === null` 表示这是不含端口段的老格式码，整串都是 secret */
export interface ParsedPairingCode {
  port: number | null;
  secret: string;
}

/**
 * 拼装复合配对码。
 *
 * 前置条件违反时**抛异常**——这里的入参来自本进程（真实监听端口 + 自己生成的 secret），
 * 违反即编程错误。与 `parsePairingCode` 的 fail-soft 刻意不对称：那边的入参是人手粘贴的。
 *
 * @param port 真实监听端口，`[1, 65535]` 内的整数
 * @param secret `generateSecret()` 的产物，非空且不含分隔符
 */
export function formatPairingCode(port: number, secret: string): string {
  if (!Number.isInteger(port) || port < 1 || port > PAIRING_CODE_PORT_MAX) {
    throw new Error(`配对码端口非法: ${port}`);
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('配对码 secret 不能为空');
  }
  // secret 里若含分隔符，页面会在错误的位置切分 → 宁可在生成侧炸掉
  if (secret.includes(PAIRING_CODE_SEPARATOR)) {
    throw new Error(`配对码 secret 不得包含 "${PAIRING_CODE_SEPARATOR}"`);
  }
  return `${port}${PAIRING_CODE_SEPARATOR}${secret}`;
}

/**
 * 解析配对码。**永不抛异常**：任何不合规输入都退化为「整串是 secret，port 为 null」，
 * 让调用方回落到候选集探测——至少还有一次连上的机会。
 *
 * 刻意不做的三件事：
 * - 不 trim（裁剪是调用方职责，两侧若各自补 trim 会静默不同步）；
 * - 不校验 secret 形状（协议不变量是「不含分隔符」，不是「64 hex」；否则将来换编码会被单方面拒掉）；
 * - 不解析 host（目标永远是 127.0.0.1，支持 host 段等于允许页面连任意主机）。
 *
 * 生产链路上桥并不解析配对码；此函数是 `formatPairingCode` 后置条件的可测形式，
 * 也是 `vectors.json` 用例表的参考实现。
 */
export function parsePairingCode(code: string): ParsedPairingCode {
  const whole: ParsedPairingCode = { port: null, secret: String(code ?? '') };
  const index = whole.secret.indexOf(PAIRING_CODE_SEPARATOR);
  if (index < 0) return whole; // R1 老格式

  const left = whole.secret.slice(0, index);
  const right = whole.secret.slice(index + PAIRING_CODE_SEPARATOR.length);
  if (!PAIRING_CODE_PORT_PATTERN.test(left)) return whole; // R3
  const port = Number(left);
  if (port > PAIRING_CODE_PORT_MAX) return whole; // R4
  if (right.length === 0) return whole; // R5
  if (right.includes(PAIRING_CODE_SEPARATOR)) return whole; // R6
  return { port, secret: right }; // R2
}
