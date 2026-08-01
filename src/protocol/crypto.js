'use strict';

/**
 * 挑战-响应的 HMAC 计算（S10）· bridge 侧。
 *
 * mac = HMAC-SHA256(secret, nonce) 的 hex 编码。
 * 页面侧用 Web Crypto 实现同一算法，protocolConformance 测试用固定向量校验两侧一致。
 *
 * secret 与 nonce 均以 UTF-8 编码进 HMAC。
 */

const crypto = require('crypto');
const { MAC_ALGORITHM } = require('./index');

/**
 * 计算 mac。
 * @param {string} secret 高熵配对码/会话密钥
 * @param {string} nonce  bridge 下发的一次性随机数
 * @returns {string} hex 编码的 HMAC
 */
function computeMac(secret, nonce) {
  return crypto
    .createHmac(MAC_ALGORITHM, Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(String(nonce), 'utf8'))
    .digest('hex');
}

/**
 * 常量时间比较候选 mac 与期望 mac，避免时序侧信道。
 * @returns {boolean}
 */
function verifyMac(secret, nonce, candidateMac) {
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
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/** 生成高熵会话密钥（配对码，256-bit hex） */
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { computeMac, verifyMac, generateNonce, generateSecret };
