/**
 * 宿主动态工具画像（B1，见 docs/rfc-versioning-and-dynamic-tools.md §5.1）。
 *
 * 背景：MCP 规范里**没有**「客户端是否遵守 notifications/tools/list_changed」的标准
 * capability 字段，而忽略该通知的宿主又在 initialize 时就冻结了工具列表。因此判断只能
 * 在 initialize 阶段靠 clientInfo 完成，此处维护一张**保守**的「已知遵守」宿主表。
 *
 * 默认策略（已批准）：未知宿主按「不支持」处理 → 暴露静态兜底工具。功能正确性优先：
 * 未知的坏宿主看不到工具就是坏掉，未知的好宿主只是多两个工具（可接受的噪音）。
 * 因此表里**只放确信遵守 list_changed 的宿主**；不确定的一律留给默认（暴露兜底）。
 */

import type { HostProfile } from './config.js';

/**
 * 已确认会遵守 tools/list_changed 的宿主（clientInfo.name 归一化后的子串）。
 * 保守起步：仅 Claude 系（Claude Code / Desktop，Anthropic 自家、完整 MCP 支持）。
 * 其余宿主经实测确认后再逐个加入（切忌误加——误加会让真正需要兜底的宿主看不到工具）。
 */
export const KNOWN_LISTCHANGED_HOSTS: readonly string[] = ['claude'];

/** 静态兜底工具名（未暴露给标准宿主，仅在 static 兜底模式下列出） */
export const PASSTHROUGH_TOOL_NAMES: readonly string[] = [
  'call_page_tool',
  'list_page_tools',
];

/** 宿主是否（确信）遵守 tools/list_changed */
export function hostHonorsListChanged(clientName: string | undefined): boolean {
  if (!clientName) return false;
  const normalized = clientName.toLowerCase();
  return KNOWN_LISTCHANGED_HOSTS.some((known) => normalized.includes(known));
}

/**
 * 是否应暴露静态兜底工具（list_page_tools / call_page_tool）。
 * - `static`：总是暴露；`standard`：从不暴露；`auto`：已知遵守→否，未知→是（已批准默认）。
 */
export function shouldExposeStaticTools(
  profile: HostProfile,
  clientName: string | undefined,
): boolean {
  if (profile === 'static') return true;
  if (profile === 'standard') return false;
  return !hostHonorsListChanged(clientName);
}
