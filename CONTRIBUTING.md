# 贡献指南

## 环境

需要 **Node ≥ 22.12**（仓库带 `.nvmrc`，`nvm use` 即可切到推荐的 24 LTS）。产物零运行时依赖，但开发期需要工具链（TypeScript / Vitest / Biome / publint / attw），所以 `git clone` 后先跑：

```bash
npm install   # prepare 钩子会顺带 build
```

## 开发循环

```bash
npm run verify   # lint → typecheck → build → test → 包形状校验，提 PR 前必须通过
npm test         # 56 用例（Vitest）
npm run test:watch
npm run lint     # Biome；lint:fix 自动修
npm run typecheck
```

**测试必须串行**（`vitest.config.ts` 里 `fileParallelism: false`）：本项目用固定端口候选集，并发跑会互相抢端口。若遇到莫名失败，先清端口：

```bash
lsof -ti :19837,:19838,:19839,:19871 | xargs kill -9
```

测试分两层：`test/unit.test.ts` 与 `test/bridge.e2e.test.ts` 直接 import `src/`（类型受检）；`test/artifact.test.ts` 只测 `dist/`（发布形态），并会在产物过期时自动重建。

## 提 PR 前

- [ ] `npm run verify` 通过
- [ ] 新增行为有对应用例（端到端优先于 mock）
- [ ] 读过 [AGENT.md §3 不可违背的约束](./AGENT.md)，确认改动不违背 A1–A13
- [ ] 涉及协议改动（消息形状 / 错误码 / `SERVICE_ID` / 版本）时同步了 `src/protocol/vectors.json`，并在 PR 描述里注明**页面侧需同步**
- [ ] 涉及安全语义改动时同步了 [docs/security.md](./docs/security.md)

## 代码风格

格式与 lint 全交给 **Biome**（`npm run lint` / `lint:fix`，配置见 `biome.json`），不手工讨论空格：

- TypeScript + ESM（`"type": "module"`）；内置模块一律 `node:` 前缀
- 单引号、分号、尾逗号、2 空格缩进、行宽 80
- 相对引入写 `.js` 后缀（NodeNext 解析）；**测试**里 import `src/` 写 `.ts` 后缀
- 注释写**为什么**，不写「做了什么」；关键约束注明它对应的安全措施编号（如 `S2`）
- 日志一律 `stderr`（stdout 是 JSON-RPC 协议通道）

类型上的两条硬规矩：对外契约（工具的 `structuredContent`、`/health` 响应、错误 `data`）必须有导出类型；测试不得用 `any` / `!` 绕过类型（Biome 会拦），该用 `src/testing` 里的 `resultOf` / `errorOf` / `structuredOf` / `readyOf` 做收窄。

## 不接受的改动

- 引入运行时依赖
- 把包改回双产物（CJS + ESM）或引入打包器（见 A13）
- 让工具返回需要 `eval` 的代码（见 A2，这是安全红线）
- 把 `BIND_HOST` 做成可配置、或放宽默认 Origin 白名单
- 在审计日志里记录配对码或工具参数值

## 安全问题

**请勿**通过公开 issue 报告，见 [SECURITY.md](./SECURITY.md)。
