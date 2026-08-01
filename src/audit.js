'use strict';

/**
 * 本地审计日志（S9）。
 *
 * 记录连接与工具调用事件，供事后排查「谁在什么时候调了什么」。
 * 只记录工具名与参数的 key 名，**不记录参数值与文档内容**（避免落盘敏感数据）。
 * token 亦不入日志。
 */

const fs = require('fs');
const path = require('path');

class AuditLog {
  /**
   * @param {{ filePath: string | null, now?: () => number }} options
   */
  constructor(options) {
    const opts = options || {};
    this.filePath = opts.filePath || null;
    this.now = opts.now || Date.now;
    this.disabledReason = null;
    if (this.filePath) this.ensureDir();
  }

  get enabled() {
    return !!this.filePath && !this.disabledReason;
  }

  ensureDir() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (error) {
      this.disabledReason = error && error.message ? error.message : String(error);
    }
  }

  /**
   * 追加一条事件。写失败只降级（记 disabledReason），绝不影响主链路。
   *
   * @param {string} event 事件名（如 session.open / tool.call / origin.rejected）
   * @param {object} [fields] 附加字段（调用方保证无敏感值）
   */
  write(event, fields) {
    if (!this.enabled) return;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      event,
      ...(fields || {}),
    });
    try {
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
    } catch (error) {
      this.disabledReason = error && error.message ? error.message : String(error);
    }
  }
}

/**
 * 从工具参数中提取可安全落盘的摘要：只保留 key 名。
 *
 * @param {unknown} args
 * @returns {string[]}
 */
function safeArgKeys(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.keys(args);
}

module.exports = { AuditLog, safeArgKeys };
