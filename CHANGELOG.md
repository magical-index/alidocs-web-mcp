# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **建连改为 agent 显式发起**：页面侧连接器不再因「发现桥」自动弹配对面板；agent 在目标页面控制台调 `window.__docMcpWsBridge.pair(配对码)` 建连。避免同一机器上 Chrome / 其它标签页都弹面板、以及多篇文档都配对后桥不知编辑哪篇的问题。本变更在页面侧（we-word），桥侧仅同步文案。

### 新增

- **静态透传兜底工具 `call_page_tool`**：恒定出现在 `tools/list`，按 `{name, arguments}` 原样转发给页面。用于部分 MCP host 不响应 `notifications/tools/list_changed`、配对后仍看不到文档工具的场景。

### 文档

- README / 中文 README / `docs/design.md` / `docs/security.md` / `install.sh` 均将配对指引从「填入页面配对框」改为「agent 控制台调 `pair(code)`」；并新增 `call_page_tool` 说明与「部分 host 不刷新工具清单」的已知限制。

## [0.1.0] - 2026-08-01

首个版本。

### 新增

- **stdio MCP server**：对外提供标准 MCP（`initialize` / `tools/list` / `tools/call` / `ping` / `resources/*`），协议版本协商支持 `2025-06-18` / `2025-03-26` / `2024-11-05`
- **localhost WS 桥**：页面主动出站连接，握手完成后双向原样透传 JSON-RPC（桥不理解工具语义）
- **HMAC 挑战-响应配对**：`challenge` → `auth(mac)` → `ready`，配对码明文永不上线
- **固定端口候选集**（19837/19838/19839）+ 占用检测，供页面自行发现
- **桥自有工具**：`get_pairing_code`（返回数据，非脚本）、`get_bridge_status`、`revoke_session`
- **`/health` 端点**：按 Origin 分级返回，白名单外只给最小信息
- **安全默认值**：仅 bind `127.0.0.1`、Origin 白名单（无宽泛通配）、默认只读、审计日志不记录凭证与参数值
- **单连接会话制**：新会话顶掉旧会话（关闭码 4008）
- **结构化诊断**：`PAGE_NOT_CONNECTED` / `PAGE_DISCONNECTED` / `PAGE_TIMEOUT` / `AUTH_FAILED` / `ORIGIN_REJECTED` / `PORT_CONTENDED` 等
- **协议一致性向量**（`src/protocol/vectors.json`）：供页面侧与本仓各自断言，防止跨实现漂移
- **测试辅助导出**（`@magical-index/alidocs-web-mcp/testing`）：下游可用真实桥进程做契约测试，包含断言辅助（`resultOf` / `errorOf` / `structuredOf` / `readyOf`）
- 56 个用例（Vitest）：单元与端到端测源码，产物 smoke 拉起真实 CLI 进程验证发布形态

### 说明

- 源码 TypeScript，发布为 **ESM-only** 的扁平 `dist/`（含 `.d.ts`）；需 **Node ≥ 22.12**，CommonJS 调用方靠 `require(esm)` 直接 `require()`
- 工具链（仅开发期）：TypeScript 7 · Vitest 4 · Biome 2 · publint + attw
- 运行时零依赖，`npx @magical-index/alidocs-web-mcp` 即可使用
- 需要文档页面侧已加载对应连接器实现；本进程不注入任何代码到页面
