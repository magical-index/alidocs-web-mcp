'use strict';

/**
 * 会话密钥（配对码）管理（S3 / S10 / S11）。
 *
 * 配对码即高熵 session secret（256-bit CSPRNG）：
 * - 经 get_pairing_code 以「数据」下发（不返回可执行代码，S13）
 * - 页面存 sessionStorage 用于刷新后重连（#3）
 * - 握手只发 HMAC(secret, nonce)，明文永不上线（S10）
 * - rotate() 供撤销/退出使用：换密钥后旧 sessionStorage 值自动失效（S11）
 *
 * v1 单密钥：进程内同时只有一个有效 secret；CLI 重启即换（per-session，符合安全约束）。
 */

const { generateSecret, verifyMac } = require('./protocol/crypto');

class SecretStore {
  /**
   * @param {{ generate?: () => string }} [options] 测试可注入确定性生成器
   */
  constructor(options) {
    const opts = options || {};
    this._generate = opts.generate || generateSecret;
    this._secret = this._generate();
    this._rotatedAt = Date.now();
  }

  /** 当前配对码（get_pairing_code 下发的数据） */
  get pairingCode() {
    return this._secret;
  }

  get rotatedAt() {
    return this._rotatedAt;
  }

  /**
   * 校验挑战响应：mac 是否等于 HMAC(current secret, nonce)。
   * @param {string} nonce
   * @param {unknown} mac
   * @returns {boolean}
   */
  verify(nonce, mac) {
    return verifyMac(this._secret, nonce, mac);
  }

  /** 轮换密钥（撤销），旧密钥立即失效 */
  rotate() {
    this._secret = this._generate();
    this._rotatedAt = Date.now();
    return this._secret;
  }
}

module.exports = { SecretStore };
