# 协议版本协商与动态工具注入 · alidocs-web-mcp RFC

| 字段 | 值 |
| --- | --- |
| slug | `versioning-and-dynamic-tools` |
| 状态 | **Draft v1（待审批）** |
| 作者 | 荷取（协作：Claude） |
| 创建 | 2026-08-02 |
| 关联 | [design](./design.md) · [security](./security.md) · we-word `rfcs/doc-agent-mcp.md`（页面侧单一真源） |

> **本文定位**：本文是「桥（alidocs-web-mcp）↔ 页面（we-word 连接器）」在**协议演进**与**动态工具注入**两个议题上的设计单点真源，覆盖两侧改动的契约与迁移。安全模型仍以 [security.md](./security.md) 为准，页面侧工具语义仍以 we-word `rfcs/doc-agent-mcp.md` 为准。本文**不**改变 HMAC 挑战-响应、bind/Origin 白名单等既有安全控制。

---

## 0. 一页速览（TL;DR）

本 RFC 回应两个待实现需求：

- **需求 A（版本演进 + 灰度兼容）**：MCP/we-word 协议更新时，桥需要「感知更新」并在 we-word **灰度期多版本共存**下与各版本页面**先后兼容**。当前是硬编码等值 `PROTOCOL_VERSION === 2`、**无协商**，版本不一致时退化成一个**不可诊断的 8s 超时**（`PROTOCOL_MISMATCH` 错误码两侧都定义了但从未触发）。
- **需求 B（静态列表宿主的动态工具注入）**：Qoder 的 MCP 工具列表**不支持动态刷新**（忽略 `notifications/tools/list_changed`），因此配对后才注入的文档工具对它不可见。当前用 `call_page_tool` 静态透传兜底，但 Agent 无法获知页面工具的名字与 schema。

**核心结论**：
1. 需求 A：把「硬等值」升级为**带兼容窗口的版本协商** + **页面→桥能力清单** + **桥自身的过期提醒**，并真正启用 `PROTOCOL_MISMATCH`。**关键前提 INV-1（§1.4）**：桥的 npm 包**永远先于**页面发布协议版本，故「页面比桥旧」是常态、需**静默降级**；**唯一真实失配是用户的桥过旧**，唯一补救是**升级桥**（不存在「刷新页面/等灰度」这一支）。
2. 需求 B：分三层落地——**B1 立即可做**（**宿主能力自适应**：宿主遵守 `listChanged` 就走标准动态工具、不挂兜底；不遵守才暴露静态 `list_page_tools`+`call_page_tool`。判断只能在 `initialize` 阶段靠 `clientInfo` 画像 + 显式开关，因 MCP 无「客户端是否遵守 listChanged」的标准字段）；**B2 中期**（桥内置「稳定核心工具清单」作为一等静态工具，让 Qoder 从启动即见真实 schema）；**B3 战略**（Qoder Agent-Native 经 `navigator.modelContext` 页内拉取，绕开 stdio/listChanged，需宿主支持）。

以下 §4 / §5 的**决策点**（标 🔲）需要审批。

---

## 1. 背景与约束

### 1.1 现状链路

```
MCP host（IDE / 终端 / Qoder） --stdio JSON-RPC--> alidocs-web-mcp（桥·哑管道）
                                                        |
                                          ws://127.0.0.1:<port>（页面主动出站）
                                                        v
                                       we-word 页面内 MCP Server（tools 提供方）
```

- 桥是**哑管道**：`tools/list` 时**实时**向页面 pull 一次并与本地工具合并（`src/router.ts:315-358`），不缓存；`tools/call` 按名路由，页面工具原样转发。
- 两条独立的「版本」轴，勿混淆：
  - **wire 协议版本**：`PROTOCOL_VERSION = 2`，随每个控制帧的 `docmcp` 字段传递（桥 `src/protocol/index.ts:24`；页面 `protocol.ts:12` 是其逐字镜像，靠 `protocolConformance.test.ts` 防漂移）。
  - **MCP 协议版本**：stdio 侧标准 MCP `initialize.protocolVersion`（桥 `SUPPORTED_PROTOCOL_VERSIONS`，`src/router.ts:14-19`），已有降级协商，不在本文重点。

### 1.2 继承约束（来自 we-word `rfcs/doc-agent-mcp.md`）

| ID | 约束 | 对本文的影响 |
| --- | --- | --- |
| **C1** | 必须在 **Qoder 内嵌浏览器**里可用 | 需求 B 的直接动因；方案不得依赖 Qoder 未提供的能力 |
| **C2** | **不要求宿主改造** | B1/B2 必须零宿主依赖；B3 需宿主支持，只能作为战略项另行推进 |
| **C3** | 对外暴露**标准 MCP** | 任何新增工具/字段不得偏离 MCP 规范 |
| **C4** | accept/reject 等需**用户明确授权** | 本文不放松；新增能力不得绕过裁决 |

### 1.3 安全约束（来自 security.md）

- **S3/S10 不动**：版本协商字段走明文没问题（非秘密），但 `mac = HMAC(pairingCode, nonce)` 的绑定关系不得削弱。
- **S13 不动**：任何新增返回值仍是**数据**，绝不返回可执行脚本。
- **S9**：新增能力清单里的版本号可入审计，但不得记录配对码。

### 1.4 发布顺序不变式（INV-1，全文基石）

> **INV-1**：**桥（npm 包）永远先于页面发布对应协议版本**。引入协议版本 N 时，先给 npm 桥加上「支持 N」（同时仍支持 N-1…），页面（we-word）随后才灰度放出 N。

由 INV-1 直接推出：

- **页面的协议版本 ≤「最新」桥的 `max`**——页面永远不会比*最新*桥更新。
- 因此「页面比桥旧」是**灰度期常态**（桥先发、页面追赶），桥**必须静默向下协商**、绝不报错。
- **唯一真实的不兼容 = 用户本地的桥过旧**（npx 缓存 / 版本被 pin 住），补救**只有一个方向：升级桥**。
- 桥**过早丢弃旧协议版本**（`min` 抬得比线上仍存活的最老页面还高）会打断未升级页面——这是**发布事故**，靠 §3.1 的窗口策略规避，不是正常态。

---

# 需求 A：协议版本演进与灰度兼容

## 2. 问题拆解

| # | 问题 | 证据 |
| --- | --- | --- |
| A-P1 | **无版本协商**：`isControlMessage` 要求 `docmcp` **精确等值**，不匹配帧被当作「非控制消息」丢弃 | 桥 `src/protocol/index.ts:127-133`；页面 `protocol.ts:94-101` |
| A-P2 | **失配不可诊断**：页面侧超时报 `HANDSHAKE_TIMEOUT`，桥侧报 `BAD_MESSAGE`+close 4003；`PROTOCOL_MISMATCH` 两侧都定义却**从不触发** | 页面 `webSocketClientTransport.ts:189-193`；桥 `session.ts:183-196`、`protocol/index.ts:60` |
| A-P3 | **灰度期多版本共存**：wire 版本与工具集是**编译期常量**打进 bundle，灰度按 user/doc 分桶且分批放量，故**同一时刻线上存在多个 bundle 版本**；用户装的**单个**桥必须同时兼容这些页面 | we-word `grays` 机制：`window.__globalConfig.switchKeys.user` → `enable_docmcp_ws_bridge` 等 |
| A-P4 | **页面→桥无版本/能力上报**：`auth.client` 仅 `{name, docId, readOnly}`，不含连接器/编辑器版本或能力清单 | we-word `mcpServerService.ts:247-251`；桥 `ReadyMessage`/`AuthMessage` |
| A-P5 | **桥不知道自己过期**：经 npx 分发，宿主可能缓存旧版；缺「请升级」信号 | 分发方式 `npx -y @magical-index/alidocs-web-mcp` |
| A-P6 | **lockstep 假设被灰度打破**：`vectors.json` 逐字一致假设两侧同版本，灰度下不成立 | `protocolConformance.test.ts` |

## 3. 设计

### 3.1 兼容策略：wire 协议做「带窗口的语义化版本」

- `PROTOCOL_VERSION` 定义为 **MAJOR**。**破坏性**变更才 +1；**加法式**变更（新增可选字段/新增工具/新增能力）**不加 MAJOR**，用**能力标志**（capability flag）声明，老实现忽略即可向后兼容。
- 桥不再声明单值，而是声明**支持区间** `[PROTOCOL_MIN, PROTOCOL_MAX]`。
- **窗口策略（由 INV-1 决定）**：`PROTOCOL_MAX` = 桥所知最新版本；`PROTOCOL_MIN` **必须 ≤ 线上仍存活的最老页面版本**，且**在该老版本灰度淘汰完成前不得抬高**。即：桥只增不减地向前扩，向后只在「确认无存活老页面」后才收。这样「页面比桥旧」永远落在窗口内。
- 页面同样带 `[min, max]`。握手时取**双方交集的最高版本**；因 INV-1，正常情况下交集非空且等于页面版本。

### 3.2 协商式握手（替换硬等值）

在**不改变 HMAC 步骤**的前提下，扩展控制帧携带版本/能力（新增字段均为可选，老实现忽略）：

```
桥 → 页面  challenge : { docmcp, type:'challenge', nonce,
                         protocolMin, protocolMax, bridgeVersion, bridgeCaps[] }   # 新增后 4 项
页面 → 桥  auth      : { docmcp, type:'auth', mac,
                         client:{ name, docId, readOnly,
                                  connectorVersion, editorVersion,
                                  protocol,               # 页面选定的版本
                                  protocolMin, protocolMax, caps[], gray? } }       # 新增
桥        校验 mac + 计算 negotiated = min(bridgeMax, pageMax) 且 ≥ max(bridgeMin, pageMin)
桥 → 页面  ready     : { docmcp:negotiated, type:'ready', sessionId, allowWrite,
                         version, protocol:negotiated, caps[] }
          若无交集 → error{ code:'PROTOCOL_MISMATCH', hint } + close 4003（终于用上该码）
```

- **无交集只有一个成因（由 INV-1）**：用户本地桥过旧（`bridgeMax < pageMin`）。故 `PROTOCOL_MISMATCH.hint` **只有一个方向**——升级桥：`请升级本地桥：npx -y @magical-index/alidocs-web-mcp@latest`。**不存在**「提示刷新页面/等灰度」这一支——页面比桥旧时是**静默协商降级**，不是错误。
- 唯一的例外「页面比桥旧到低于 `bridgeMin`」在窗口策略（§3.1）正确执行下**不应发生**；若发生即为桥**过早收窗**的发布事故，按 bug 处理而非用户可自救的失配。
- 桥把 `negotiated`、`connectorVersion`、`editorVersion`、`gray` 记入 `get_bridge_status` 与白名单内 `/health`（便于诊断「连的是哪个灰度桶的哪个连接器」）。

### 3.3 v2 → v3 的自举难点（关键设计细节）🔲

难点：当前 `docmcp` 精确等值**门控** `isControlMessage`，所以「让 challenge 可被跨版本读到」这件事本身就是破坏性的。由 INV-1，桥先发 v3-支持（区间 `[2,3]`），此时线上页面仍是 v2，之后页面才灰度到 v3。建议方案：

- **规则**：`challenge` 帧永远用**桥支持区间的最低版本**作为 `docmcp` 发出，保证老页面能识别；同时携带 `protocolMax`。
- 老页面（v2，不认识 `protocolMax`）：按 v2 继续，正常配对 → **不回退**。这正是桥先发、页面未追上的**常态**，必须无感。
- 新页面（v3+）：读到 `protocolMax≥3` → 后续帧升到协商版本。
- 「新页面 + 桥只支持到 v2」**只会**出现在**用户桥过旧**时（INV-1 保证*最新*桥已支持 v3）→ 走 §3.2 的唯一补救「升级桥」。因此**当前**桥永远不会遇到比自己新的页面。
- 代价：`isControlMessage` 需从「等值」改为「区间容忍 + 按 `type` 分派」。这是 v3 的核心破坏点，需两侧同步发布并各自补「区间容忍」的单测。

### 3.4 能力清单（页面→桥）

`auth.client` 扩展为携带 `connectorVersion / editorVersion / caps[] / gray`（见 §3.2）。收益：
- 诊断：状态里能看到「连的是哪个连接器版本」。
- 灰度感知：桥可据 `caps[]` 决定是否暴露某新工具（配合需求 B 的清单来源）。
- 为未来「按能力而非按版本」的门控打基础。

### 3.5 桥的「过期提醒」🔲

由 INV-1，**桥过旧是唯一的真实不兼容成因**，所以「让用户的桥保持最新」不是锦上添花，而是**兼容性的主干**。两条互补手段：

- **被动（零出网，必做）**：`npx -y …@latest` 本身每次即拉最新；真正失配时靠 §3.2 的 `PROTOCOL_MISMATCH.hint` 明确指向升级。这条不需要任何额外网络行为。
- **主动（出网，可选）**：启动时（可选每小时）对 npm registry 做一次**尽力而为**的最新版本查询；落后则 **stderr 打印升级提示** + 在 `get_bridge_status` 暴露 `{ latestVersion, updateAvailable }`。**失败开放**：离线/超时/被墙一律静默继续，不阻断启动，不发送任何遥测。
- 决策点 A-2：是否接受这一**主动出网**查询？它能在「还没失配、但桥已过旧」时**提前**提醒用户；代价是一次对外请求。若拒绝，则仅保留被动路径。

### 3.6 版本化一致性向量

- `vectors.json` → 版本化为 `vectors/v2.json`、`v3.json`…；两仓各自对**每个支持版本**跑 conformance，使「灰度共存」被测试覆盖，而非只测 latest×latest。

### 3.7 兼容矩阵（示例）

因 INV-1，「桥」这一列在正常态总是**最新桥**（`max` ≥ 任何线上页面）：

| 桥支持 | 页面版本 | 结果 | 是否正常态 |
| --- | --- | --- | --- |
| [2,3]（最新） | 2 | 协商到 2，静默降级 | ✅ 灰度期常态（桥先发、页面未追上） |
| [2,3]（最新） | 3 | 协商到 3 | ✅ 页面已追上 |
| **[2,2]（用户桥过旧）** | 3 | `bridgeMax<pageMin` → `PROTOCOL_MISMATCH`，**唯一补救=升级桥** | ⚠️ 唯一真实失配 |
| ~~[3,4]~~ | 2 | **不会发生**：桥收窗到 `min=3` 的前提是线上已无 v2 页面（§3.1 窗口策略）；若发生即发布事故 | ❌ 违反 INV-1/窗口策略 |

---

# 需求 B：静态列表宿主（Qoder）的动态工具注入

## 4. 问题拆解

| # | 问题 | 证据 |
| --- | --- | --- |
| B-P1 | 文档工具**配对后**才出现，靠 `notifications/tools/list_changed` 通告；Qoder **在 initialize 冻结列表、忽略该通知** → 页面工具不可见 | 桥 `notifyToolsListChanged` `src/router.ts:571-577`，仅在页面 connect/disconnect 触发 |
| B-P2 | 现有兜底 `call_page_tool` 是**单个静态工具**，Agent **不知道**可调的页面工具名与 schema，只能靠带外知识拼 `{name, arguments}` | 桥 `src/index.ts:100-128`、`src/router.ts:149-172` |
| B-P3 | we-word 侧工具**连接时一次性注册**、`capabilities.tools.listChanged` 留空（undefined），本无运行时增删 | we-word `connection.ts:264-374`；`buildDocumentTools(readOnly)` |
| B-P4 | 工具 schema 由**页面**定义，且可能**随灰度/版本变化**；桥是哑管道，先验不知道 schema | 见需求 A |

> 注：桥的 `initialize` 已声明 `capabilities.tools.listChanged:true`（`src/router.ts:299-312`）——对**遵守**通知的宿主是对的；Qoder 属于**不遵守**的一类，需要与「动态」无关的静态可达路径。

## 5. 设计（三层，可叠加）

### 5.1 B1 — 宿主能力自适应：标准 listChanged 优先，静态透传兜底（立即可做，零宿主依赖）✅ 推荐先行

**核心思路**：桥先判断宿主是否遵守 `notifications/tools/list_changed`。
- **遵守**（标准 MCP，如 Claude Code）→ 走**标准能力**：配对后动态注入页面工具、发 `list_changed`，宿主自会重拉 `tools/list`。此时**不暴露** `call_page_tool`/`list_page_tools`，避免「同一操作两条路径」污染模型选择。
- **不遵守**（静态列表，如 Qoder）→ 启用 **B1 兜底**：把 `list_page_tools`（发现）+ `call_page_tool`（透传）作为**启动即在**的静态工具。Agent 流程：先 `list_page_tools` 发现 → 再 `call_page_tool{name, arguments}` 调用。

#### 5.1.1 如何判断宿主是否支持 listChanged 🔲

**难点**：MCP 规范里**没有**「客户端是否遵守 `tools/list_changed`」的标准 capability 字段（客户端 capabilities 只有 `roots`/`sampling`/`elicitation` 等，均与此无关）。而忽略通知的宿主又在 `initialize` 时就**冻结**了列表——所以判断**必须在 `initialize` 阶段**完成，那一刻唯一可用的信号是 `clientInfo`。三条手段，按可靠性排序：

| 手段 | 时机 | 说明 | 局限 |
| --- | --- | --- | --- |
| **① clientInfo 画像表（主）** | initialize | 维护 `clientInfo.name`(+版本区间) → `{honorsListChanged}` 的**已知宿主表**：如 Claude Code=是、Qoder=否 | 需实测采集各宿主的 `clientInfo.name/version` 建表；未知宿主要有默认策略 |
| **② 显式开关（覆盖）** | 启动参数 | `--host-profile <standard\|static\|auto>`（默认 `auto`）或 `--[no-]static-tools`，强制覆盖①的判断 | 需用户/宿主配置知道自己该选哪个 |
| **③ 行为探针（旁证/遥测）** | 首次页面连接后 | 发出 `list_changed` 后，在窗口内**观察宿主是否重发 `tools/list`**；据此记日志、校准①的表 | **改不了已冻结的列表**，对当次的坏宿主太晚；只用于诊断与建表，不用于当次决策 |

- **未知宿主的默认策略（✅ 已批准 2026-08-02）**：默认按**「不支持」**处理（暴露 B1 静态工具）——功能正确性优先：未知的坏宿主若看不到工具就是**坏掉**，而未知的好宿主只是多了两个工具（可接受的噪音）。反向默认会让未知坏宿主静默不可用。
- 无论走哪条路，未配对时 `list_page_tools`/`call_page_tool` 返回 `PAGE_NOT_CONNECTED` + 配对指引（复用现有错误语义）。
- `capabilities.tools.listChanged:true` 仍如实声明（这是**桥**的能力，属实）；是否**额外**挂载 B1 静态工具由上面的判断决定，二者不矛盾。

#### 5.1.2 属性

- **满足 C1/C2/C3**：全静态、无需宿主改造、标准 MCP；数据即 schema，不返回脚本（S13）。
- 局限：clientInfo 画像表需持续维护（新宿主/改名/版本）；兜底路径是两跳、schema 不被宿主原生校验（由页面二次校验）、靠 instructions 引导模型「先 list 再 call」。

### 5.2 B2 — 内置「稳定核心工具清单」为一等静态工具（中期）🔲

- 桥从**启动即**把文档核心工具（`read_document`/`get_blocks`/`get_document_metadata`/`search`/`update_block`/`insert_blocks`/`delete_blocks`/`accept_all_changes`/`reject_all_changes`/`get_doc_skill`）**作为一等 MCP 工具**列出（配对前即可见，真实 per-tool schema）。
- 调用路由到页面；未配对 → `PAGE_NOT_CONNECTED` + 配对指引；写工具在 `allowWrite=false` 时按 security S5 处理。
- 代价与张力：桥需**内置一份工具清单**，**削弱哑管道纯度**；且清单要应对灰度/版本差异（与需求 A 挂钩）。
- **化解**：只内置**长期稳定核心**（versioned manifest），灰度专属/更新的工具仍走 `call_page_tool` 兜底；配对后对**遵守通知**的宿主仍给「实时合并列表 + listChanged」，两条路并存。
- **决策点**：
  - 🔲 是否接受「桥内置核心清单」这一纯度让步？
  - 🔲 清单**单一真源**在哪？（we-word 拥有 schema；桥需要一份**生成拷贝** + CI 校验一致，避免手抄漂移。）
  - 🔲 触发方式：`--static-tools` 显式开启，还是按宿主指纹自动开启（Qoder → 开）？

### 5.3 B3 — Agent-Native / `navigator.modelContext`（战略，需宿主支持）🔲

- Qoder「Agent Native」下 Agent 可**驱动内嵌浏览器**：直接读页面已装的 `navigator.modelContext` polyfill（we-word `modelContextRegistry.ts`，pull 模型、无生命周期回调）**在页内**发现并调用工具，**绕开** stdio 桥与 listChanged。
- 「从 agent Native 设计触发」即指此路径：由 Qoder 的 agent-native 能力在页内触发发现，天然规避「工具列表不可动态更新」。
- 属**页面侧 + 宿主侧**改动，违反 C2（需宿主支持），故作为**战略端态**与 Qoder / we-word 协同推进，不阻塞 B1/B2。

### 5.4 三方案对比

| 维度 | B1 宿主自适应(标准优先+静态兜底) | B2 静态核心清单 | B3 Agent-Native |
| --- | --- | --- | --- |
| 宿主依赖(C2) | 无 | 无 | **需支持** modelContext/CDP |
| 原生 per-tool schema | 否（数据） | **是** | 是（页内） |
| 哑管道纯度 | 保持 | **让步** | 保持（不经桥） |
| 落地成本 | 低 | 中 | 高（跨团队） |
| 覆盖灰度新工具 | 是（透传） | 核心内置+新工具透传 | 是（页内实时） |
| 建议 | **先行** | 中期主力 | 战略端态 |

---

## 6. 分阶段落地

1. **阶段 1（本仓，非破坏）**：B1（`list_page_tools` + 增强 `call_page_tool`/instructions）。同时补 A 的诊断——把「首帧版本失配」从 `BAD_MESSAGE` 细分出真正的 `PROTOCOL_MISMATCH`（即使暂不做完整协商，先给可诊断错误 + 升级 hint）。
2. **阶段 2（跨仓协同，破坏性 v3）**：A 的完整协商（§3.2/§3.3）+ 能力清单（§3.4）+ 版本化向量（§3.6）；两仓同步发版并各补区间容忍单测。
3. **阶段 3（中期）**：B2 静态核心清单（含清单单一真源 + CI 一致性校验）。
4. **阶段 4（战略）**：B3 与 Qoder / we-word 协同。
5. **横切**：A 的过期提醒（§3.5，若审批通过出网）。

## 7. 待审批决策点汇总

- 🔲 **A-1**：wire 协议升级为「区间协商」并 bump 到 v3，支持窗口 ≥ 2 个 MAJOR？（§3.1–3.3）
- 🔲 **A-2**：桥启动做 npm 最新版查询（出网、失败开放）以「感知更新」，还是零出网、仅失配时 hint？（§3.5）
- **B-1**：先落 B1（宿主自适应：标准优先、静态兜底）。(a) ✅ **已批准**：未知宿主默认按「不支持 listChanged」处理（暴露兜底工具）。🔲 待定：(b) 是否提供 `--host-profile`/`--static-tools` 显式覆盖？(c) 是否需要行为探针做遥测建表？（§5.1）
- 🔲 **B-2**：是否接受 B2「桥内置稳定核心清单」的哑管道纯度让步？清单单一真源与触发方式怎么定？（§5.2）
- 🔲 **B-3**：Qoder 是否具备 `navigator.modelContext` / CDP 注入能力，值不值得投 B3？（§5.3）

## 8. 未决 / 风险

- **v2↔v3 自举**（§3.3）：`isControlMessage` 从等值改区间是唯一硬破坏点，需两仓严格同步，否则灰度期真的会「升级即碎」。
- **清单漂移**（B2）：桥内置清单与 we-word 真源不一致会造成「列了却调不通」；必须 CI 校验，宁可少列（未列的走 `call_page_tool`）也不错列。
- **模型引导**（B1）：两跳 flow 依赖 instructions；需在 eval 里验证模型确实会「先 list 再 call」。
- **能力清单非秘密**：`caps/version` 明文可被本地进程观察，但不含配对码，不构成新增泄露（对齐 security 残余风险）。
