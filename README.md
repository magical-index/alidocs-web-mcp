# alidocs-web-mcp

把**浏览器里已经打开的那篇钉钉文档**的编辑能力，桥接给任意 MCP host。

对外是标准 stdio MCP server，对内经 `ws://127.0.0.1` 连接文档页面内的 MCP Server，透传页面提供的文档工具。

```
任意 MCP host（IDE / 终端 / 桌面 Agent）
   ↕ stdio（标准 MCP）
alidocs-web-mcp（本进程：配对 + 哑管道转发）
   ↕ ws://127.0.0.1:19837（页面主动出站连接）
文档页面内的 MCP Server → 文档工具 → 建议态修改
```

**特点**

- **零运行时依赖**：纯 Node ≥ 18，手写 WS 帧编解码，`npx` 即用
- **零脚本注入**：不下发任何需要 `eval` 的代码；配对码只是一串数据
- **桥不理解工具语义**：页面新增工具无需改本进程
- **写操作走建议态**：修改以可接受/可拒绝的建议呈现，落盘由用户裁决

> 前提：文档页面侧需已加载对应的连接器实现（页面自己发现本进程并发起配对）。本进程只是桥，不注入任何东西到页面。

## 快速开始

### 1. 注册给 MCP host

```json
{
  "mcpServers": {
    "alidocs-web-mcp": {
      "command": "npx",
      "args": ["-y", "alidocs-web-mcp", "--allow-write"]
    }
  }
}
```

或从源码运行：

```bash
node bin/alidocs-web-mcp.js --allow-write
```

默认依次尝试端口 **19837 / 19838 / 19839**，用第一个空闲端口（页面据此发现本进程）。

### 2. 配对（三步）

1. Agent 调 `get_pairing_code` → 得到**配对码字符串**与端口
2. 在已打开的文档页面「本地 Agent」面板里填入配对码并确认（Agent 可用 UI 自动化填写，用户也可从终端复制粘贴）
3. 之后 `tools/list` 会出现文档工具，按标准 MCP 调用

页面刷新 / 同标签同源跳转后会用 `sessionStorage` 里的配对码**自动重连**，无需再次配对。

## 桥自有工具

| 工具 | 作用 |
| --- | --- |
| `get_pairing_code` | 返回配对码（数据）+ 端口 + 写权限状态。**不返回脚本** |
| `get_bridge_status` | 端口、是否已建桥、页面是否就绪、在途请求、Origin 白名单、审计日志路径 |
| `revoke_session` | 轮换配对码并断开当前会话；页面侧存储的旧码立即失效 |

其余工具全部来自页面，本进程只透传。

## CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--port <n>` | 只用该端口（默认走候选集 19837/19838/19839） |
| `--allow-origin <pattern>` | 追加 Origin 白名单（可重复），`*` 只匹配单个 label/端口 |
| `--only-origin <pattern>` | 用给定条目**完全替换**默认白名单 |
| `--allow-write` | 允许页面注册写工具（默认只读） |
| `--audit-log <path>` / `--no-audit` | 审计日志路径 / 关闭（默认 `~/.alidocs-web-mcp/audit.log`） |
| `--handshake-timeout-ms <n>` | WS 握手等待时限（默认 10000） |
| `--request-timeout-ms <n>` | 转发给页面的请求超时（默认 60000） |

默认 Origin 白名单含**官方文档环境（生产 + 预发）与本地开发域**，逐条枚举；**不做 `*.dingtalk.com` 之类宽泛通配**，以免任意子域页面都能连本地桥。自建域显式追加：

```bash
npx -y alidocs-web-mcp --allow-origin 'https://your-env.example.com'
```

## 安全模型（摘要）

四个攻击方向各有正交防御，缺一不可：

| 方向 | 防御 |
| --- | --- |
| ① 恶意网页 → 本地 | 只 bind `127.0.0.1` + **Origin 白名单**（upgrade 阶段 403） |
| ② 本地恶意进程 → 桥 | **运行时 CSPRNG 配对码**（Origin 可伪造，凭证不可猜） |
| ③ 本地冒充者抢端口 | **HMAC 挑战-响应**（配对码明文永不上线）+ 端口占用检测 |
| ④ 分发/提示投毒 | **凭证以数据传递**，绝不返回可执行脚本；默认只读；写操作只产生建议 |

另有：`/health` 按 Origin 分级（白名单外拿不到 `connected`/`allowWrite` 等指纹）、单连接会话制、审计日志不记录配对码与参数值。

**完整威胁模型与措施清单见 [docs/security.md](./docs/security.md)。**

## 线协议

`src/protocol/` 是协议单一真源（零依赖）：

```
page → bridge:  OPEN(ws://127.0.0.1:<port>)      # 桥校验 Origin
bridge → page:  { docmcp:2, type:'challenge', nonce }
page → bridge:  { docmcp:2, type:'auth', mac }   # mac = HMAC-SHA256(pairingCode, nonce)
bridge → page:  { docmcp:2, type:'ready', sessionId, allowWrite, version }
                { docmcp:2, type:'error', code, message } + close 4003（失败）
page → bridge:  { docmcp:2, type:'bye' }
```

握手完成后双向原样透传 JSON-RPC。`src/protocol/vectors.json` 是跨实现一致性向量：页面侧（Web Crypto）与本仓（node crypto）必须算出同一个 mac，两侧测试各自断言，防止协议漂移。

设计取舍与三个不可拆分的耦合见 [docs/design.md](./docs/design.md)。

## 开发

```bash
npm test          # 49 用例（node --test，串行，因用固定端口）
npm run test:unit # 仅单元
npm run test:e2e  # 仅端到端
npm run lint      # 语法检查
npm run verify    # lint + test
```

无需 `npm install`——本项目零依赖（含开发期）。

下游做契约测试可用真实桥进程：

```js
const { startTestBridge, connectFakePage } = require('alidocs-web-mcp/test-helpers');
```

## 文档

- [docs/design.md](./docs/design.md) — 设计说明与取舍
- [docs/security.md](./docs/security.md) — 安全设计单一真源
- [AGENT.md](./AGENT.md) — AI Agent 协作约定（改动本仓前必读）
- [CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [CHANGELOG.md](./CHANGELOG.md)

## License

[MIT](./LICENSE)
