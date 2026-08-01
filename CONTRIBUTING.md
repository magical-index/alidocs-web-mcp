# 贡献指南

## 环境

只需 **Node ≥ 18**。本项目零依赖（运行时与开发期都没有），`git clone` 后直接就能跑测试，无需 `npm install`。

## 开发循环

```bash
npm run verify   # = lint + test，提 PR 前必须通过
npm test         # 49 用例
npm run test:unit
npm run test:e2e
```

**测试必须串行**（脚本里已固定 `--test-concurrency=1`）：本项目用固定端口候选集，并发跑会互相抢端口。若遇到莫名失败，先清端口：

```bash
lsof -ti :19837,:19838,:19839 | xargs kill -9
```

## 提 PR 前

- [ ] `npm run verify` 通过
- [ ] 新增行为有对应用例（端到端优先于 mock）
- [ ] 读过 [AGENT.md §3 不可违背的约束](./AGENT.md)，确认改动不违背 A1–A12
- [ ] 涉及协议改动（消息形状 / 错误码 / `SERVICE_ID` / 版本）时同步了 `src/protocol/vectors.json`，并在 PR 描述里注明**页面侧需同步**
- [ ] 涉及安全语义改动时同步了 [docs/security.md](./docs/security.md)

## 代码风格

- CommonJS，`'use strict'`
- 2 空格缩进（见 `.editorconfig`）
- 注释写**为什么**，不写「做了什么」；关键约束注明它对应的安全措施编号（如 `S2`）
- 日志一律 `stderr`（stdout 是 JSON-RPC 协议通道）

未引入 ESLint 是刻意取舍：保持零依赖、CI 免安装。`npm run lint` 用 `node --check` 做语法门禁。

## 不接受的改动

- 引入运行时依赖
- 让工具返回需要 `eval` 的代码（见 A2，这是安全红线）
- 把 `BIND_HOST` 做成可配置、或放宽默认 Origin 白名单
- 在审计日志里记录配对码或工具参数值

## 安全问题

**请勿**通过公开 issue 报告，见 [SECURITY.md](./SECURITY.md)。
