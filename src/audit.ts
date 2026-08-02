/**
 * 本地审计日志（S9）。
 *
 * 记录连接与工具调用事件，供事后排查「谁在什么时候调了什么」。
 * 只记录工具名与参数的 key 名，**不记录参数值与文档内容**（避免落盘敏感数据）。
 * 配对码亦不入日志。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuditLogOptions {
  filePath: string | null;
  now?: () => number;
}

export class AuditLog {
  private readonly filePath: string | null;

  private readonly now: () => number;

  private disabledReason: string | null = null;

  constructor(options?: AuditLogOptions) {
    this.filePath = options?.filePath ?? null;
    this.now = options?.now ?? Date.now;
    if (this.filePath) this.ensureDir(this.filePath);
  }

  get enabled(): boolean {
    return !!this.filePath && !this.disabledReason;
  }

  /** 当前日志路径（未启用时为 null），供诊断展示 */
  get path(): string | null {
    return this.enabled ? this.filePath : null;
  }

  private ensureDir(filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (error) {
      this.disabledReason = toMessage(error);
    }
  }

  /**
   * 追加一条事件。写失败只降级（记 disabledReason），绝不影响主链路。
   *
   * @param event 事件名（如 session.open / tool.call / ws.upgrade.rejected）
   * @param fields 附加字段（调用方保证无敏感值）
   */
  write(event: string, fields?: Record<string, unknown>): void {
    if (!this.enabled || !this.filePath) return;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      event,
      ...(fields || {}),
    });
    try {
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
    } catch (error) {
      this.disabledReason = toMessage(error);
    }
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * 从工具参数中提取可安全落盘的摘要：只保留 key 名。
 *
 * 这是 S9 的实现要点——参数值可能含文档内容，绝不落盘。
 */
export function safeArgKeys(args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.keys(args as Record<string, unknown>);
}
