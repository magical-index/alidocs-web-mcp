# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
- **测试辅助导出**（`alidocs-web-mcp/testing`）：下游可用真实桥进程做契约测试，包含断言辅助（`resultOf` / `errorOf` / `structuredOf` / `readyOf`）
- 56 个用例（Vitest）：单元与端到端测源码，产物 smoke 拉起真实 CLI 进程验证发布形态

### 说明

- 源码 TypeScript，发布为 **ESM-only** 的扁平 `dist/`（含 `.d.ts`）；需 **Node ≥ 22.12**，CommonJS 调用方靠 `require(esm)` 直接 `require()`
- 工具链（仅开发期）：TypeScript 7 · Vitest 4 · Biome 2 · publint + attw
- 运行时零依赖，`npx alidocs-web-mcp` 即可使用
- 需要文档页面侧已加载对应连接器实现；本进程不注入任何代码到页面
