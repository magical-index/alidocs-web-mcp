#!/bin/sh
# alidocs-web-mcp 一键安装脚本
#
# 用途：校验环境 → 预热 npx 缓存 → 把 MCP server 注册进宿主。
# 支持的宿主：
#   - Claude Code (CLI)：有 `claude` 命令时自动 `claude mcp add --scope user`
#   - Qoder：官方仅提供 UI 里的 JSON 编辑器（Settings → MCP → + Add，快捷键 ⌘⇧,），
#            没有公开稳定的磁盘配置路径，所以这里打印可直接粘贴的 JSON 片段。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/magical-index/alidocs-web-mcp/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --allow-write        # 允许页面注册写工具
#   ./install.sh --allow-write --force                        # 本地运行
#
# 选项：
#   --allow-write   注册时带上 --allow-write（默认只读）
#   --name <name>   MCP server 名（默认 alidocs-web-mcp）
#   --force         已存在同名 server 时替换（仅影响 Claude Code user scope）
#   --skip-verify   跳过 npx 预热校验（离线或想更快时用）
#   -h, --help      显示帮助

set -eu

PKG="@magical-index/alidocs-web-mcp"
NAME="alidocs-web-mcp"
ALLOW_WRITE=0
FORCE=0
SKIP_VERIFY=0

# ---- 输出辅助（非 TTY 时自动去色，便于 curl|sh 与日志）---------------------
if [ -t 1 ]; then
  C_BOLD="$(printf '\033[1m')"; C_DIM="$(printf '\033[2m')"
  C_GREEN="$(printf '\033[32m')"; C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"; C_CYAN="$(printf '\033[36m')"; C_RESET="$(printf '\033[0m')"
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
fi
info()  { printf '%s\n' "${C_CYAN}▸${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
err()   { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
die()   { err "$@"; exit 1; }

usage() {
  # 打印文件顶部连续的注释块（跳过 shebang），到第一行非注释为止
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit 0
}

# ---- 解析参数 --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-write) ALLOW_WRITE=1 ;;
    --force)       FORCE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --name)        shift; [ $# -gt 0 ] || die "--name 需要一个值"; NAME="$1" ;;
    --name=*)      NAME="${1#--name=}" ;;
    -h|--help)     usage ;;
    *)             die "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

# 组装传给 bridge 的参数（--allow-write 可选）
if [ "$ALLOW_WRITE" -eq 1 ]; then
  RUN_ARGS_JSON="\"-y\", \"$PKG\", \"--allow-write\""
  set -- -y "$PKG" --allow-write
else
  RUN_ARGS_JSON="\"-y\", \"$PKG\""
  set -- -y "$PKG"
fi

printf '\n%s\n\n' "${C_BOLD}alidocs-web-mcp 安装器${C_RESET}"

# ---- 1. 校验 Node ≥ 22.12 --------------------------------------------------
command -v node >/dev/null 2>&1 || die "未找到 node。请先安装 Node.js ≥ 22.12（https://nodejs.org）。"
command -v npx  >/dev/null 2>&1 || die "未找到 npx（通常随 Node 一起安装）。"

NODE_VER="$(node -v | sed 's/^v//')"          # e.g. 22.12.0
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"; NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  die "Node 版本过低：v${NODE_VER}。本工具是 ESM-only，需要 Node ≥ 22.12。"
fi
ok "Node v${NODE_VER}（满足 ≥ 22.12）"

# ---- 2. 预热 / 校验包能拉起 ------------------------------------------------
if [ "$SKIP_VERIFY" -eq 1 ]; then
  info "已跳过 npx 校验（--skip-verify）"
else
  info "拉取并校验 ${PKG}（首次会下载，稍等）…"
  if npx -y "$PKG" --help >/dev/null 2>&1; then
    ok "$PKG 可正常拉起"
  else
    warn "npx 预热失败（可能是网络或包尚未发布）。已继续注册配置，可稍后重试 npx -y $PKG --help"
  fi
fi

# ---- 3. 注册到 Claude Code (CLI) -------------------------------------------
printf '\n%s\n' "${C_BOLD}Claude Code (CLI)${C_RESET}"
if command -v claude >/dev/null 2>&1; then
  if claude mcp get "$NAME" >/dev/null 2>&1; then
    if [ "$FORCE" -eq 1 ]; then
      info "已存在同名 server，--force 生效：先移除再添加"
      claude mcp remove "$NAME" -s user >/dev/null 2>&1 || true
      claude mcp add --scope user "$NAME" -- npx "$@"
      ok "已在 user scope 重新注册 $NAME"
    else
      warn "Claude Code 已存在 server \"$NAME\"，跳过。要覆盖请加 --force。"
    fi
  else
    claude mcp add --scope user "$NAME" -- npx "$@"
    ok "已注册到 Claude Code（user scope，所有项目可用）"
  fi
else
  warn "未找到 claude CLI，跳过自动注册。装好后可手动执行："
  printf '  %sclaude mcp add --scope user %s -- npx %s%s\n' \
    "$C_DIM" "$NAME" "$(if [ "$ALLOW_WRITE" -eq 1 ]; then echo "-y $PKG --allow-write"; else echo "-y $PKG"; fi)" "$C_RESET"
fi

# ---- 4. Qoder：打印可粘贴片段 ---------------------------------------------
printf '\n%s\n' "${C_BOLD}Qoder${C_RESET}"
info "打开 Qoder → Settings（⌘⇧, / Ctrl+Shift+,）→ MCP → My Servers → + Add，粘贴："
cat <<EOF
${C_DIM}{
  "mcpServers": {
    "$NAME": {
      "command": "npx",
      "args": [$RUN_ARGS_JSON]
    }
  }
}${C_RESET}
EOF

# ---- 5. 结语 + 配对提醒 ----------------------------------------------------
printf '\n%s\n' "${C_GREEN}${C_BOLD}安装完成${C_RESET}"
cat <<EOF
下一步：
  1. 在浏览器打开钉钉文档（页面侧需已内置连接器）。
  2. 让 agent 调 ${C_BOLD}get_pairing_code${C_RESET} 拿到配对码与端口。
  3. 让 agent 在目标页面的控制台调 ${C_BOLD}window.__docMcpWsBridge.pair(配对码)${C_RESET} 建连；完成 HMAC 握手后 tools/list 才会出现文档工具。

${C_DIM}提示：桥默认只读；本次注册$(if [ "$ALLOW_WRITE" -eq 1 ]; then echo "已"; else echo "未"; fi)带 --allow-write。
若 get_bridge_status 一直 connected:false，多半是页面侧连接器尚未就绪，而非配置问题。${C_RESET}
EOF
