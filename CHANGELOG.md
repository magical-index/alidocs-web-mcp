# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-08-10

### 变更

- **配对码改为复合 token `<port>.<secret>`**（对外行为变更，故走 minor）：`get_pairing_code` 下发的字符串里含桥的真实监听端口，页面据此**直连点名端口**，不再按 19837 → 19838 → 19839 的顺序探候选集。动机：多个 Agent 各起一个桥时，端口被当成实例标识，页面只能发现占住第一个端口的那个桥，其余桥的配对码会被送到错误的进程上、握手失败并误报成 `AUTH_FAILED`。HMAC **只对 secret 段**计算，明文仍永不上线；不含 `.` 的老格式码行为与 0.1.x 逐字一致（页面退回候选集探测）。
- **`--port 0` 现在合法**，语义为「让 OS 分配一个空闲的临时端口」——多实例场景的推荐配置（端口由配对码携带，`PORT_CONTENDED` 的冲突面随之消失）。`-1` / `65536` / 非整数仍报错。
- 默认监听行为不变：不带 `--port` 时仍是 19837 → 19838 → 19839。

### 文档

- README / 中文 README 新增「同时跑多个 Agent」小节（`--port 0`，以及全局安装需 `npm i -g @magical-index/alidocs-web-mcp@latest` 才会升级）；订正「端口必须固定，页面靠探测固定端口发现」的旧说法。
- `docs/design.md` §3.1 前提修正（端口是数据，走配对码这条既有数据通道不引入新能力；固定候选集降级为兜底手段）、§3.2 与 §8 同步。

### 说明

- 新增 `src/protocol/pairingCode.ts`（`formatPairingCode` / `parsePairingCode`）与 `vectors.json` 的 `pairingCode` 用例表；解析规则由该向量表在两仓各自的测试里钉住。鉴权路径（`src/secrets.ts` / `src/session.ts` / `src/wsServer.ts`）零改动。
- **多实例要真正生效，页面侧连接器也需支持复合码**；只升级桥不改页面时，页面会按老格式退回候选集探测。

## [0.1.1] - 2026-08-05

### 变更

- **建连改为 agent 显式发起**：页面侧连接器不再因「发现桥」自动弹配对面板；agent 在目标页面控制台调 `window.__docMcpWsBridge.pair(配对码)` 建连。避免同一机器上 Chrome / 其它标签页都弹面板、以及多篇文档都配对后桥不知编辑哪篇的问题。本变更在页面侧（we-word），桥侧仅同步文案。

### 修复

- **`initialize` 的 instructions 与工具错误 hint 仍指向「页面配对框」**：上一轮文案同步漏改了 `src/router.ts` 里的 4 处副本，使得 agent 拿到的首要指引（`instructions`）与 `PAGE_NOT_CONNECTED` 的自愈提示都是去找一个已不存在的配对框。现收成单一真源 `PAIRING_HINT`，统一指向 `window.__docMcpWsBridge.pair(code)`。

### 文档

- README / 中文 README / `docs/design.md` / `docs/security.md` / `install.sh` 均将配对指引从「填入页面配对框」改为「agent 控制台调 `pair(code)`」；并新增 `call_page_tool` 说明与「部分 host 不刷新工具清单」的已知限制。

## [0.1.0] - 2026-08-02

首个版本。

### 新增

- **stdio MCP server**：对外提供标准 MCP（`initialize` / `tools/list` / `tools/call` / `ping` / `resources/*`），协议版本协商支持 `2025-06-18` / `2025-03-26` / `2024-11-05`
- **localhost WS 桥**：页面主动出站连接，握手完成后双向原样透传 JSON-RPC（桥不理解工具语义）
- **HMAC 挑战-响应配对**：`challenge` → `auth(mac)` → `ready`，配对码明文永不上线
- **固定端口候选集**（19837/19838/19839）+ 占用检测，供页面自行发现
- **桥自有工具**：`get_pairing_code`（返回数据，非脚本）、`get_bridge_status`、`revoke_session`；以及静态透传兜底的 `list_page_tools` / `call_page_tool`（恒定出现在 `tools/list`，按 `{name, arguments}` 原样转发给页面，用于部分 MCP host 不响应 `notifications/tools/list_changed`、配对后仍看不到文档工具的场景）
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
