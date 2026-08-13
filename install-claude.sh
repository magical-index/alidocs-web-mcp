#!/bin/sh
# alidocs-web-mcp · Claude Code 安装
#
# Claude Code 的 `plugin install` 只认 marketplace，且插件清单格式与 Qoder 不同，
# 所以这里分两步各装一半：
#   MCP   → claude mcp add --scope user
#   Skill → 拷到 ~/.claude/skills/（Claude Code 从该目录自动加载）
#
# 用法：
#   ./install-claude.sh              # MCP + skill 都装
#   ./install-claude.sh --mcp-only
#   ./install-claude.sh --skill-only
#   ./install-claude.sh --force      # 覆盖已存在的 MCP 配置 / skill 目录
#   ./install-claude.sh --dry-run

set -eu

PKG="@magical-index/alidocs-web-mcp"
NAME="alidocs-web-mcp"
SKILL="alidocs-edit-routing"
SKILLS_DIR="$HOME/.claude/skills"
DO_MCP=1
DO_SKILL=1
FORCE=0
DRY=0

if [ -t 1 ]; then
  C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m'); C_GREEN=$(printf '\033[32m')
  C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m'); C_CYAN=$(printf '\033[36m'); C_RESET=$(printf '\033[0m')
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
fi
info() { printf '%s\n' "${C_CYAN}▸${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; exit 1; }
run()  { if [ "$DRY" -eq 1 ]; then printf '%s\n' "${C_DIM}\$ $*${C_RESET}"; else "$@"; fi; }

SELF_NAME="install-claude.sh"

# ---- curl | sh 自举 --------------------------------------------------------
# 被管道执行时 $0 是 "sh"，身边没有仓库内容（skill 源在 skills/）。此时把仓库浅
# clone 到临时目录再从那里重跑自己。ALIDOCS_BOOTSTRAPPED 防止无限自举。
REPO_URL="${ALIDOCS_REPO:-https://github.com/magical-index/alidocs-web-mcp.git}"
bootstrap_from_repo() {
  [ "${ALIDOCS_BOOTSTRAPPED:-0}" = "1" ] && die "自举后仍找不到仓库内容，请检查 ${REPO_URL}"
  command -v git >/dev/null 2>&1 || die "需要 git 来获取仓库内容（或先 clone 仓库再运行本脚本）"
  info "未在仓库内运行，浅 clone 到临时目录：${REPO_URL}"
  _tmp=$(mktemp -d) || die "无法创建临时目录"
  git clone --depth 1 --quiet "$REPO_URL" "$_tmp/repo" || die "clone 失败：${REPO_URL}"
  [ -f "$_tmp/repo/$SELF_NAME" ] || die "远端仓库里没有 $SELF_NAME（可能尚未推送）"
  ALIDOCS_BOOTSTRAPPED=1 export ALIDOCS_BOOTSTRAPPED
  # 用保存的原始参数重跑（此时 $@ 已被解析循环 shift 空）
  eval "exec sh \"$_tmp/repo/$SELF_NAME\" $ORIG_ARGS"
}

# 保存原始参数，供自举 re-exec 原样传递（解析循环会 shift 掉 $@）
ORIG_ARGS=""
for _a in "$@"; do
  ORIG_ARGS="$ORIG_ARGS \"$_a\""
done

while [ $# -gt 0 ]; do
  case "$1" in
    --mcp-only)   DO_SKILL=0 ;;
    --skill-only) DO_MCP=0 ;;
    --force)      FORCE=1 ;;
    --dry-run)    DRY=1 ;;
    -h|--help)    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "未知参数：$1" ;;
  esac
  shift
done

command -v claude >/dev/null 2>&1 || die "未找到 claude CLI。请先安装 Claude Code。"

# 若要装 skill 且不在仓库内，先自举——必须早于 MCP 块，否则 re-exec 会让 MCP 步骤跑两遍。
if [ "$DO_SKILL" -eq 1 ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  SRC="$SCRIPT_DIR/skills/$SKILL"
  if [ ! -f "$SRC/SKILL.md" ] && command -v npm >/dev/null 2>&1; then
    CANDIDATE="$(npm root -g 2>/dev/null)/$PKG/skills/$SKILL"
    [ -f "$CANDIDATE/SKILL.md" ] && SRC="$CANDIDATE"
  fi
  [ -f "$SRC/SKILL.md" ] || bootstrap_from_repo
fi

printf '\n%s\n\n' "${C_BOLD}alidocs-web-mcp · Claude Code${C_RESET}"

# ---- MCP -------------------------------------------------------------------
# --port 0：端口由 OS 分配并写进配对码。不这么配的话，多个 host 各起一个桥会把
# 19837/19838/19839 占满，后启动的桥直接 PORT_CONTENDED 退出，Claude 侧表现为
# "Failed to connect / Connection closed"——看起来像装错了，其实是端口抢占。
if [ "$DO_MCP" -eq 1 ]; then
  if claude mcp get "$NAME" >/dev/null 2>&1; then
    if [ "$FORCE" -eq 1 ]; then
      info "MCP 已存在，--force 生效：先移除"
      run claude mcp remove "$NAME" -s user || warn "移除失败，继续尝试添加"
      run claude mcp add --scope user "$NAME" -- npx -y "$PKG" --port 0 --allow-write
      ok "MCP 已重新注册（user scope）"
    else
      warn "Claude 里已存在 MCP server \"$NAME\"，跳过。要覆盖请加 --force。"
      printf '%s\n' "${C_DIM}  提示：旧配置若用固定端口或全局 bin，可能因端口抢占而连不上；建议 --force 重装成 npx + --port 0。${C_RESET}"
    fi
  else
    run claude mcp add --scope user "$NAME" -- npx -y "$PKG" --port 0 --allow-write
    ok "MCP 已注册（user scope，所有项目可用）"
  fi
fi

# ---- Skill -----------------------------------------------------------------
if [ "$DO_SKILL" -eq 1 ]; then
  if [ ! -f "$SRC/SKILL.md" ]; then
    warn "找不到 skill 源（$SCRIPT_DIR/skills/${SKILL}）。跳过 skill 安装。"
  elif [ -e "$SKILLS_DIR/$SKILL" ] && [ "$FORCE" -eq 0 ]; then
    warn "$SKILLS_DIR/$SKILL 已存在，跳过。要覆盖请加 --force。"
  else
    run mkdir -p "$SKILLS_DIR"
    [ -e "$SKILLS_DIR/$SKILL" ] && run rm -rf "$SKILLS_DIR/$SKILL"
    run cp -R "$SRC" "$SKILLS_DIR/$SKILL"
    ok "Skill 已装到 $SKILLS_DIR/$SKILL"
  fi
fi

[ "$DRY" -eq 1 ] && exit 0

printf '\n%s\n' "下一步："
printf '  1. %s重启 Claude Code%s（skill 与 MCP 都在会话启动时加载）。\n' "$C_BOLD" "$C_RESET"
printf '  2. 浏览器打开目标钉钉文档，说「帮我连上我现在打开的这篇钉钉文档」。\n'
printf '  3. 验证：%sclaude mcp get %s%s 应显示已连接。\n' "$C_DIM" "$NAME" "$C_RESET"
printf '\n%s\n' "${C_DIM}skill 把 dws 当前置：没有 dws 时「直改」通道不可用，只能走建议态。
若 get_bridge_status 一直 connected:false，通常是页面侧连接器尚未全量开放，不是配置问题。${C_RESET}"
