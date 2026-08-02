# AGENT.md · alidocs-web-mcp

面向 AI Agent 的仓库协作说明。修改本仓前先读完本文。

## 1. 这个仓库是什么

钉钉文档（alidocs）的本地 MCP 桥。**对外** stdio 标准 MCP server（任意 MCP host 可接），**对内** `ws://127.0.0.1` 连接浏览器里已打开的文档页面，把页面提供的文档工具透传给 Agent。

设计与安全的**单一真源就在本仓**：

- [docs/design.md](./docs/design.md) — 链路、三个不可拆分的耦合、哑管道设计、会话生命周期、已知取舍
- [docs/security.md](./docs/security.md) — 四方向威胁模型、凭证模型、握手、端点契约、S1–S13 措施清单

## 2. 目录结构与模块边界

```
src/protocol/          ← 协议单一真源（零运行时依赖）
  index.ts             协议版本、服务标识(SERVICE_ID)、控制消息类型、关闭码、错误码、消息构造器、类型定义
  crypto.ts            HMAC 挑战-响应（computeMac / verifyMac / generateNonce / generateSecret）
  vectors.json         跨实现一致性向量（页面侧测试也读它；构建时拷到 dist/）
src/                   ← bridge 实现层
  config.ts            CLI 参数、端口候选集、Origin 白名单匹配
  secrets.ts           配对码（= session secret）存储与轮换
  session.ts           挑战-响应握手 + 单连接会话制
  wsServer.ts          手写 WS server（upgrade/Origin 校验/health/多候选 bind）
  frames.ts            WS 帧编解码
  router.ts            JSON-RPC 路由：host↔page 双向转发、id 重映射、工具合并、超时
  stdio.ts             stdio 通道（换行分隔 JSON）
  audit.ts             审计日志（不记凭证与参数值）
  index.ts             组装层 + 桥自有工具（其 structuredContent 契约以 type 导出）
  cli.ts               启动入口（编译为 dist/cli.js，即 npx 入口）
  testing/             测试辅助（**公开 API**：`alidocs-web-mcp/testing`）
    wsClient.ts        零依赖 WS 测试客户端
    harness.ts         起真桥 + 假 host/页面 + 断言辅助（resultOf/errorOf/structuredOf/readyOf）
dist/                  ← tsc 产物（**ESM-only**，扁平结构 + .d.ts），不入版本库
test/                   ← Vitest（TypeScript）
  unit.test.ts         帧编解码 / Origin / secret / 协议一致性（测 src）
  bridge.e2e.test.ts   端到端链路（测 src）
  artifact.test.ts     产物 smoke（测 dist：shebang、exports、vectors、真实 CLI 进程）
```

**技术栈**：TypeScript 7（`tsc` 直出，无打包器）· Vitest 4 · Biome 2（lint + format）· publint + attw（包形状）。全部 devDependencies，产物零运行时依赖。

**为何测试分两层**：

- 单元 / e2e **直接 import `src/*.ts`**：类型受检——改坏签名或结构化返回的形状，`npm run typecheck` 立刻报，不必等断言在 `undefined` 上炸；覆盖率也能映射回源码。
- `artifact.test.ts` **只测 `dist/`**：守编译本身能引入的问题（shebang 丢失、`exports` 指向不存在的文件、`vectors.json` 没拷、ESM 下 `__dirname` 之类失效写法）。它在 `dist/` 缺失或比 `src/` 旧时**自动重建**，所以不会出现「测到旧产物」。

**依赖方向硬约束**：`src/*.ts` 可以依赖 `src/protocol/*`，**反之不可**。protocol 层不得引入任何运行时依赖、不得感知 bridge 实现细节——它是页面侧共同依赖的契约。

## 3. 不可违背的约束（改动前必读）

| # | 约束 | 原因 |
| --- | --- | --- |
| A1 | **零运行时依赖**：`dependencies` 必须为空。`devDependencies` 只允许构建/类型/测试/质量工具（当前：typescript、@types/node、vitest、@biomejs/biome、publint、@arethetypeswrong/cli） | `npx` 即用；运行时引入依赖带来安装与供应链风险。`artifact.test.ts` 有硬断言拦住 |
| A2 | **绝不返回可执行代码给调用方** | 方向④ RCE：桥若下发脚本 + agent `eval`，冒充桥/污染分发即可在用户已登录会话执行任意 JS。配对码只能是**数据** |
| A3 | 只 bind `127.0.0.1`（`config.js` 的 `BIND_HOST` 不做成可配置） | S1 |
| A4 | Origin 白名单在 **upgrade 阶段**校验，不通过直接 403 | S2，方向①的唯一屏障 |
| A5 | 默认白名单**不得**加入宽泛通配（如 `*.example.com`）或非生产环境域 | 任意子域页面都能连本地桥；非生产域属部署方私有信息 |
| A6 | 配对码只用于**本地计算 HMAC**，明文永不上线 | S10；也是凭证可持久化的前提 |
| A7 | 默认只读；写工具需显式 `--allow-write` | S5 |
| A8 | 审计日志**不得**记录配对码、工具参数值（只记参数 key） | S9 |
| A9 | `/health` 按 Origin 分级：白名单外不得看到 `connected`/`allowWrite` 等指纹；ACAO 不用 `*` | S2 / 踩点防护 |
| A10 | 桥**不理解工具语义**：除自有三工具外一律透传，不校验/不改写页面工具参数 | 哑管道设计，换页面实现不用改桥 |
| A11 | 改协议（消息形状/错误码/`SERVICE_ID`/版本）必须同步更新 `src/protocol/vectors.json` **且**通知页面侧 | 否则两侧 drift，链路静默失配 |
| A12 | 任何日志走 **stderr** | stdout 是 JSON-RPC 协议通道，`console.log` 会污染协议流 |
| A13 | 包保持 **ESM-only**（`"type": "module"`，`exports` 手写不交给构建工具接管）；不用 `__dirname`/`require`，路径一律走 `import.meta.url` | Node ≥ 22.12 的 `require(esm)` 已让 CJS 调用方可直接 require，双产物徒增复杂度；ESM 下 `__dirname` 会静默报错被 try/catch 吃掉 |

## 4. 常用命令

```bash
npm install         # 首次：装开发依赖（prepare 钩子会顺带 build）
npm run build       # clean + tsc -p tsconfig.build.json → dist/ 并拷 vectors.json
npm test            # Vitest 全量（串行，因用固定端口）：unit + e2e 测 src，artifact 测 dist
npm run typecheck   # tsc --noEmit（覆盖 src/ 与 test/）
npm run lint        # biome check（lint + 格式）；lint:fix 自动修
npm run check:package # publint --strict + attw（ESM-only profile）
npm run verify      # lint → typecheck → build → test → check:package（提 PR 前必跑）
npm start           # 手动起桥（只读）
npm run start:write # 手动起桥（允许写工具）
```

**改完源码可直接 `npm test`**：`artifact.test.ts` 发现 `dist/` 比 `src/` 旧会自动重建；单元与 e2e 本来就跑源码。

**测试必须串行**（`vitest.config.ts` 里 `fileParallelism: false`）：桥用固定端口候选集，并发跑会互相抢端口。

清理残留进程：

```bash
lsof -ti :19837,:19838,:19839,:19871 | xargs kill -9
```

## 5. 改动工作流

1. **读**：先读 §3 约束 + `docs/`，确认改动不违背
2. **改**：改 `src/`下的 TypeScript；碰到协议就同步 `src/protocol/vectors.json`
3. **测**：`npm run verify`（lint → typecheck → build → test → 包形状）；新增行为必须有对应用例（e2e 优先于 mock）
4. **验证残留**：确认无端口占用、无 zombie 进程
5. **协议变更额外一步**：告知页面侧同步 TS 镜像实现，两侧一致性测试都要跑

## 6. 已知陷阱

- **固定端口 + 并发测试** = 抢端口假失败。始终串行；跑测试前清端口。
- **server-initiated challenge**：桥 accept 后**主动**发 challenge。任何 WS 客户端（含测试辅助）必须在 open 前装好 `onmessage`，或在装配后补投缓冲消息，否则死等。
- **页面刷新即断桥**：断连后在途请求要立刻回结构化错误（`PAGE_DISCONNECTED`），不能挂起等超时。
- **配对码轮换语义**：`revoke_session` 后，页面 `sessionStorage` 里的旧码必然 `AUTH_FAILED`，这是设计而非 bug；页面侧应据此清存储并提示重新配对。
- **产物与源码双层测试的分工**：改了发布形态（`exports` / `bin` / 新增非代码资源）要同步 `test/artifact.test.ts`；它是唯一看得到 `dist/` 的一层。
- **`vectors.json` 需拷贝步骤**：tsc 不搬未被 import 的资源，靠 `copy:assets` 完成；新增非代码资源时记得一并拷。
- **版本号读取方式**：`src/index.ts` 用 `new URL('../package.json', import.meta.url)` 运行时读。**不可改回 `__dirname`**（ESM 无此变量，会被外层 try/catch 吃成 `0.0.0` 而不报错）；也不能 `import '../package.json'`（越出 rootDir）。`artifact.test.ts` 里有一条用例死守这一点。
- **lockfile 里的 registry 必须是公共源**：仓库带 `.npmrc` 钉住 `registry.npmjs.org`。若在配了内网镜像的机器上绕过它跑 `npm install`，镜像地址会写进 `package-lock.json` 的 `resolved`，后果有两条——公共 CI 拉不到（表现为 `npm ci` 一直重试到超时，且报错挂在 Install 步骤上，很难联想到 registry）、内网基础设施地址泄进公开仓库。改依赖后务必 `grep -c 'resolved": "https://registry.npmjs.org' package-lock.json` 核对，并确认没有其它域名。
- **`node_modules/.package-lock.json` 是隐藏真源**：只删 `package-lock.json` 重装并不会换掉 `resolved` 域名，必须连 `node_modules` 一起删。
- **`npm install --package-lock-only` 会失败**：`prepare` 钩子在没有 node_modules 时跑 build，tsc 找不到 `@types/node`。只想更新 lockfile 时加 `--ignore-scripts`。
- **`/health` 分级易被无意破坏**：给它加字段时，务必确认新字段只对白名单内可见。

## 7. 与页面侧的契约

页面侧需实现：
- 协议 TS 镜像（与 `src/protocol/` **逐字一致**）
- WS 客户端 + 挑战-响应握手
- 连接器：探测 `/health` 候选端口发现本进程、配对、`sessionStorage` 重连、撤销

跨实现验证：两侧各自加载 `vectors.json` 断言常量与 HMAC。**不要用"各自 mock"替代**——那会形成契约幻觉；正确做法是页面侧用本仓导出的 `alidocs-web-mcp/testing` 起真实桥做契约测试。
