/**
 * 会话密钥（配对码）管理（S3 / S10 / S11）。
 *
 * 配对码即高熵 session secret（256-bit CSPRNG）：
 * - 经 get_pairing_code 以「数据」下发（不返回可执行代码，S13）
 * - 页面存 sessionStorage 用于刷新后重连
 * - 握手只发 HMAC(secret, nonce)，明文永不上线（S10）
 * - rotate() 供撤销/退出使用：换密钥后旧 sessionStorage 值自动失效（S11）
 *
 * v1 单密钥：进程内同时只有一个有效 secret；CLI 重启即换（per-session，符合安全约束）。
 */

import { generateSecret, verifyMac } from './protocol/crypto.js';

export interface SecretStoreOptions {
  /** 测试可注入确定性生成器 */
  generate?: () => string;
}

export class SecretStore {
  private readonly generateFn: () => string;

  private secret: string;

  private rotatedAtMs: number;

  constructor(options?: SecretStoreOptions) {
    this.generateFn = options?.generate ?? generateSecret;
    this.secret = this.generateFn();
    this.rotatedAtMs = Date.now();
  }

  /** 当前配对码（get_pairing_code 下发的数据） */
  get pairingCode(): string {
    return this.secret;
  }

  get rotatedAt(): number {
    return this.rotatedAtMs;
  }

  /** 校验挑战响应：mac 是否等于 HMAC(current secret, nonce) */
  verify(nonce: string, mac: unknown): boolean {
    return verifyMac(this.secret, nonce, mac);
  }

  /** 轮换密钥（撤销），旧密钥立即失效 */
  rotate(): string {
    this.secret = this.generateFn();
    this.rotatedAtMs = Date.now();
    return this.secret;
  }
}
