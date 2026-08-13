#!/bin/sh
# alidocs-web-mcp · Qoder 安装
#
# Qoder 支持插件：一个插件同时装好 MCP server 与 skill。仓库里不存放插件目录，
# 本脚本按需生成后交给 qodercli 安装（qodercli 只接受目录，不接受 zip）。
#
# 用法：
#   ./install-qoder.sh                      # 从本仓库 skills/ 生成插件并安装
#   ./install-qoder.sh <plugin.zip|目录>     # 用给定的插件包安装
#   ./install-qoder.sh --scope local        # 只在当前项目生效（默认 user）
#   ./install-qoder.sh --force              # 已安装时先卸载再装
#   ./install-qoder.sh --pack-only          # 只生成插件包，不安装
#   ./install-qoder.sh --dry-run

set -eu

PKG="@magical-index/alidocs-web-mcp"
NAME="alidocs-web-mcp"
SKILL="alidocs-edit-routing"
VERSION="0.2.0"
STAGE_ROOT="$HOME/.alidocs-web-mcp/plugin"
SCOPE="user"
FORCE=0
DRY=0
PACK_ONLY=0
SOURCE=""

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

SELF_NAME="install-qoder.sh"

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
    --scope) shift; [ $# -gt 0 ] || die "--scope 需要一个值"; SCOPE="$1" ;;
    --scope=*) SCOPE="${1#--scope=}" ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --pack-only) PACK_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "未知参数：$1" ;;
    *) SOURCE="$1" ;;
  esac
  shift
done

case "$SCOPE" in user|project|local) ;; *) die "--scope 只能是 user / project / local" ;; esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR="$STAGE_ROOT/$NAME"

printf '\n%s\n\n' "${C_BOLD}alidocs-web-mcp · Qoder${C_RESET}"

# ---- 准备插件目录 ----------------------------------------------------------
if [ -n "$SOURCE" ]; then
  [ -e "$SOURCE" ] || die "找不到：$SOURCE"
  case "$SOURCE" in
    *.zip)
      command -v unzip >/dev/null 2>&1 || die "需要 unzip 来解压 $SOURCE"
      info "解压插件包：$SOURCE"
      run rm -rf "$PLUGIN_DIR"
      run mkdir -p "$PLUGIN_DIR"
      run unzip -q "$SOURCE" -d "$PLUGIN_DIR"
      ;;
    *)
      [ -f "$SOURCE/.qoder-plugin/plugin.json" ] || die "$SOURCE 不是插件目录（缺 .qoder-plugin/plugin.json）"
      PLUGIN_DIR="$SOURCE"
      info "使用现成插件目录：$PLUGIN_DIR"
      ;;
  esac
else
  # 从仓库生成：manifest + mcp.json + skill 拷贝
  SKILL_SRC="$SCRIPT_DIR/skills/$SKILL"
  [ -f "$SKILL_SRC/SKILL.md" ] || bootstrap_from_repo "$@"
  info "从 skills/ 生成插件到 $PLUGIN_DIR"
  if [ "$DRY" -eq 0 ]; then
    rm -rf "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR/.qoder-plugin" "$PLUGIN_DIR/assets" "$PLUGIN_DIR/skills"
    cp -R "$SKILL_SRC" "$PLUGIN_DIR/skills/$SKILL"

    # --port 0：端口由 OS 分配并写进配对码。用固定端口的话，多个 host 各起一个桥会
    # 占满 19837/19838/19839，后启动的桥直接 PORT_CONTENDED 退出，host 侧表现为
    # "Connection closed"——看着像装错了，其实是端口抢占。
    cat > "$PLUGIN_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "$NAME": {
      "command": "npx",
      "args": ["-y", "$PKG", "--port", "0", "--allow-write"]
    }
  }
}
JSON

    cat > "$PLUGIN_DIR/.qoder-plugin/plugin.json" <<JSON
{
  "name": "$NAME",
  "displayName": "alidocs-web-mcp（钉钉文档桥）",
  "version": "$VERSION",
  "description": "Local MCP bridge exposing the DingTalk Doc page already open in your browser, plus a skill that routes how edits land.",
  "descriptionZh": "把浏览器里已打开的钉钉文档接给 AI Agent，改动落成建议态由你裁决；附带路由 skill，改文档前先问走直改还是建议态。",
  "author": { "name": "nitonitori" },
  "homepage": "https://github.com/magical-index/alidocs-web-mcp#readme",
  "repository": "https://github.com/magical-index/alidocs-web-mcp",
  "logo": "./assets/avatar.svg",
  "keywords": ["qoder-plugin", "skill", "mcp", "dingtalk", "alidocs"],
  "category": "developer-tools",
  "tags": ["skill", "mcp"],
  "skills": "./skills/",
  "mcpServers": "./mcp.json"
}
JSON

    cat > "$PLUGIN_DIR/assets/avatar.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="alidocs-web-mcp">
  <rect width="64" height="64" rx="14" fill="#1F5FBF"/>
  <rect x="12" y="15" width="40" height="30" rx="4" fill="#FFFFFF"/>
  <rect x="12" y="15" width="40" height="7" rx="4" fill="#B3D4FC"/>
  <circle cx="17" cy="18.5" r="1.4" fill="#1F5FBF"/>
  <circle cx="21.5" cy="18.5" r="1.4" fill="#1F5FBF"/>
  <rect x="18" y="27" width="28" height="2.6" rx="1.3" fill="#1F5FBF"/>
  <rect x="18" y="32" width="22" height="2.6" rx="1.3" fill="#1F5FBF" opacity="0.55"/>
  <rect x="18" y="37" width="14" height="2.6" rx="1.3" fill="#4B86C9" opacity="0.75"/>
  <path d="M32 45 v6" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="32" cy="53.5" r="3.6" fill="#FFFFFF"/>
  <circle cx="32" cy="53.5" r="1.5" fill="#1F5FBF"/>
</svg>
SVG
  fi
fi

# ---- 只打包 ----------------------------------------------------------------
if [ "$PACK_ONLY" -eq 1 ]; then
  ZIP="$PWD/$NAME-plugin-$VERSION.zip"
  command -v zip >/dev/null 2>&1 || die "需要 zip 命令"
  run rm -f "$ZIP"
  if [ "$DRY" -eq 0 ]; then
    (cd "$PLUGIN_DIR" && zip -rq "$ZIP" . -x "**/.DS_Store" "__MACOSX/*")
    ok "已打包：$ZIP"
    printf '%s\n' "${C_DIM}qodercli 只接受目录，装的时候用：./install-qoder.sh $ZIP${C_RESET}"
  fi
  exit 0
fi

# ---- 安装 ------------------------------------------------------------------
command -v qodercli >/dev/null 2>&1 || die "未找到 qodercli。若你只用 Qoder 图形界面，请在 Settings → 插件 里手动导入插件目录：$PLUGIN_DIR"

if qodercli plugin list --json 2>/dev/null | grep -q "\"name\": *\"$NAME\""; then
  if [ "$FORCE" -eq 1 ]; then
    info "已安装，--force 生效：先卸载"
    run qodercli plugin uninstall --scope "$SCOPE" "$NAME" || warn "卸载失败，继续尝试安装"
  else
    warn "Qoder 里已存在插件 \"$NAME\"，跳过。要覆盖请加 --force。"
    exit 0
  fi
fi

run qodercli plugin validate "$PLUGIN_DIR"
run qodercli plugin install --scope "$SCOPE" "$PLUGIN_DIR"

[ "$DRY" -eq 1 ] && exit 0

ok "已安装到 $SCOPE scope"
printf '\n%s\n' "下一步："
printf '  1. 在 Qoder 里执行 %s/plugins reload%s 生效。\n' "$C_BOLD" "$C_RESET"
printf '  2. 浏览器打开目标钉钉文档，对 Agent 说「帮我连上我现在打开的这篇钉钉文档」。\n'
printf '\n%s\n' "${C_DIM}插件含 MCP server（${NAME}）与 skill（${SKILL}）。
若 get_bridge_status 一直 connected:false，通常是页面侧连接器尚未全量开放，不是配置问题。${C_RESET}"
