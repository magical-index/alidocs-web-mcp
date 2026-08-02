/**
 * 挑战-响应的 HMAC 计算（S10）· bridge 侧。
 *
 * mac = HMAC-SHA256(secret, nonce) 的 hex 编码。
 * 页面侧用 Web Crypto 实现同一算法，两侧各自用 `vectors.json` 的固定向量校验一致性。
 *
 * secret 与 nonce 均以 UTF-8 编码进 HMAC。
 */

import * as crypto from 'node:crypto';
import { MAC_ALGORITHM } from './index.js';

/**
 * 计算 mac。
 *
 * @param secret 高熵配对码/会话密钥
 * @param nonce bridge 下发的一次性随机数
 * @returns hex 编码的 HMAC
 */
export function computeMac(secret: string, nonce: string): string {
  return crypto
    .createHmac(MAC_ALGORITHM, Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(String(nonce), 'utf8'))
    .digest('hex');
}

/**
 * 常量时间比较候选 mac 与期望 mac，避免时序侧信道。
 *
 * 长度不等时提前返回：mac 长度固定（64 hex 字符）且不是秘密，
 * 因此这里的提前返回不泄露额外信息，而 `timingSafeEqual` 要求等长入参。
 */
export function verifyMac(
  secret: string,
  nonce: string,
  candidateMac: unknown,
): boolean {
  if (typeof candidateMac !== 'string' || candidateMac.length === 0) {
    return false;
  }
  const expected = computeMac(secret, nonce);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const candidateBuf = Buffer.from(candidateMac, 'utf8');
  if (expectedBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

/** 生成一次性 challenge nonce（128-bit hex） */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 生成高熵会话密钥（配对码，256-bit hex） */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
