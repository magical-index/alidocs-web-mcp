/**
 * 测试：bridge 端到端链路（stdio ↔ WS）· 方案 C′
 *
 * 覆盖：
 * - initialize → tools/list（含页面工具）→ tools/call 透传真实结果
 * - 断桥后返回结构化错误而非挂起；重新配对恢复
 * - 恶意 Origin / 错误 mac 被拒（挑战-响应）
 * - 单连接会话制（新桥顶掉旧桥）、握手超时、/health Origin 分级、审计日志
 * - revoke_session 轮换密钥后旧配对码失效
 *
 * 直接测 `src/`：桥的对外形状（工具结果、错误 data、控制消息）都有类型，
 * 改坏契约在类型检查阶段就会暴露，不必等断言跑到 undefined 上。
 */

import type { AddressInfo } from 'node:net';
import { expect, it, onTestFinished } from 'vitest';

import type { BridgeStatus, RevokeStatus } from '../src/index.ts';
import { computeMac } from '../src/protocol/crypto.ts';
import {
  CONTROL_TYPE,
  SERVICE_ID,
  type ChallengeMessage,
  type ErrorMessage,
  type ReadyMessage,
} from '../src/protocol/index.ts';
import {
  connectFakePage,
  errorOf,
  fetchPairingCode,
  handshakeErrorOf,
  initializeHost,
  readyOf,
  resultOf,
  startTestBridge,
  structuredOf,
  waitUntil,
  type HostMessage,
  type InitializeResult,
  type ToolCallResult,
  type ToolsListResult,
} from '../src/testing/harness.ts';
import { connectWs } from '../src/testing/wsClient.ts';
import type { HealthPayload } from '../src/wsServer.ts';

// ---- 会话与工具发现 ----

it('initialize 返回 bridge 自身的 serverInfo 与 tools 能力', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const result = resultOf<InitializeResult>(
    await initializeHost(env.host, '2025-06-18'),
  );
  expect(result.protocolVersion).toBe('2025-06-18');
  expect(result.serverInfo.name).toBe(SERVICE_ID);
  expect(result.capabilities.tools?.listChanged).toBe(true);
  expect(result.instructions).toMatch(/get_pairing_code/);
});

// 上一轮把建连改成 agent-only 时漏改了 router.ts，agent 拿到的 instructions 仍在
// 教它去找一个已不存在的「配对框」。这里把建连指引钉死：既断言指向 pair()，也断言
// 旧模型的措辞不再出现——否则文案回退不会有任何测试报警。
it('instructions 与未建桥的错误提示都指向 pair(code)，不再提配对框', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const result = resultOf<InitializeResult>(await initializeHost(env.host));
  expect(result.instructions).toContain('window.__docMcpWsBridge.pair');
  expect(result.instructions).not.toContain('配对框');

  // 未建桥时的工具错误也走同一份文案真源
  const call = resultOf<ToolCallResult>(
    await env.host.request('tools/call', {
      name: 'call_page_tool',
      arguments: { name: 'read_document', arguments: {} },
    }),
  );
  const text = JSON.stringify(call.content);
  expect(text).toContain('window.__docMcpWsBridge.pair');
  expect(text).not.toContain('配对框');
});

it('initialize 对不支持的协议版本回落到最新版本', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const result = resultOf<InitializeResult>(
    await initializeHost(env.host, '1999-01-01'),
  );
  expect(result.protocolVersion).toBe('2025-06-18');
});

it('未建桥时 tools/list 只有 bridge 自有工具', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/list', {});
  const { tools } = resultOf<ToolsListResult>(response);
  expect(tools.map((tool) => tool.name)).toEqual([
    'get_pairing_code',
    'get_bridge_status',
    'revoke_session',
    'call_page_tool',
    'list_page_tools',
  ]);
});

it('未建桥时调用文档工具返回 isError + PAGE_NOT_CONNECTED（不挂起）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: {},
  });
  const result = resultOf<ToolCallResult<{ code: string }>>(response);
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.code).toBe('PAGE_NOT_CONNECTED');
  expect(result.content[0]?.text).toMatch(/get_pairing_code/);
});

it('未建桥时 call_page_tool 返回 isError + PAGE_NOT_CONNECTED', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: { name: 'read_document', arguments: {} },
  });
  const result = resultOf<ToolCallResult<{ code: string }>>(response);
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.code).toBe('PAGE_NOT_CONNECTED');
});

it('call_page_tool 参数校验拒绝空 name 或非对象 arguments', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const missingName = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: {},
  });
  expect(structuredOf<{ code: string }>(missingName).code).toBe(
    'INVALID_PARAMS',
  );

  const emptyName = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: { name: '' },
  });
  expect(structuredOf<{ code: string }>(emptyName).code).toBe('INVALID_PARAMS');

  const badArgs = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: { name: 'read_document', arguments: 'not-an-object' },
  });
  expect(structuredOf<{ code: string }>(badArgs).code).toBe('INVALID_PARAMS');
});

it('get_pairing_code 返回配对码数据（非脚本），默认只读', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { response, status, pairingCode } = await fetchPairingCode(env.host);
  expect(status.port).toBe(env.port);
  expect(status.allowWrite).toBe(false);
  expect(status.pairingCode).toBe(pairingCode);
  expect(pairingCode.length).toBe(64); // 256-bit hex
  // S13：返回的是数据，不含可执行脚本
  const text = JSON.stringify(response.result);
  expect(!/=>/.test(text)).toBeTruthy();
  expect(!/evaluate_script/.test(text)).toBeTruthy();
});

it('--allow-write 控制 allowWrite 标志', async () => {
  const roEnv = await startTestBridge();
  onTestFinished(() => roEnv.stop());
  await initializeHost(roEnv.host);
  const ro = await fetchPairingCode(roEnv.host);
  expect(ro.status.allowWrite).toBe(false);

  const rwEnv = await startTestBridge({ allowWrite: true });
  onTestFinished(() => rwEnv.stop());
  await initializeHost(rwEnv.host);
  const rw = await fetchPairingCode(rwEnv.host);
  expect(rw.status.allowWrite).toBe(true);
});

// ---- 安全：bind / Origin / 挑战-响应 ----

it('S1：socket 只 bind 在环回地址上', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const address = env.bridge.wsServer.server.address() as AddressInfo | null;
  expect(address?.address).toBe('127.0.0.1');
  expect(env.config.host).toBe('127.0.0.1');
});

it('端口取自固定候选集', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  expect(env.config.portCandidates.includes(env.port)).toBeTruthy();
});

it('S2：恶意 Origin 在 upgrade 阶段被 403 拒绝', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  await expect(
    connectWs({ port: env.port, origin: 'https://evil.com' }),
  ).rejects.toMatchObject({
    status: 403,
    rejectReason: 'ORIGIN_REJECTED',
  });

  const events = env.readAudit().map((entry) => entry.event);
  expect(events.includes('ws.upgrade.rejected')).toBeTruthy();
});

it('S2：缺失 Origin 头同样被拒', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  await expect(connectWs({ port: env.port })).rejects.toMatchObject({
    status: 403,
  });
});

it('S10：Origin 合法但 mac 错误 → error + 4003 关闭', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson<ChallengeMessage>();
  expect(challenge.type).toBe(CONTROL_TYPE.CHALLENGE);
  client.sendJson({ docmcp: 2, type: 'auth', mac: 'f'.repeat(64), client: {} });

  const reply = await client.nextJson<ErrorMessage>();
  expect(reply.type).toBe(CONTROL_TYPE.ERROR);
  expect(reply.code).toBe('AUTH_FAILED');

  const closed = await client.waitClose();
  expect(closed.code).toBe(4003);

  const events = env.readAudit().map((entry) => entry.event);
  expect(events.includes('session.auth.failed')).toBeTruthy();
});

it('S10：mac 由 secret+nonce 派生，secret 明文永不上线', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson<ChallengeMessage>();
  // 页面发出的 auth 帧里只有 mac，没有配对码本身
  const mac = computeMac(pairingCode, challenge.nonce);
  client.sendJson({ docmcp: 2, type: 'auth', mac, client: {} });
  const ready = await client.nextJson<ReadyMessage>();
  expect(ready.type).toBe(CONTROL_TYPE.READY);
  // 上线的消息里不得出现配对码明文
  expect(!client.messages.some((m) => m.includes(pairingCode))).toBeTruthy();
});

it('握手超时未发 auth 的连接被 4009 关闭', async () => {
  const env = await startTestBridge({ handshakeTimeoutMs: 120 });
  onTestFinished(() => env.stop());

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  await client.nextJson(); // challenge
  const closed = await client.waitClose();
  expect(closed.code).toBe(4009);
});

it('S7：/health 对白名单内/外分级返回', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());

  const allowed = (await fetch(`http://127.0.0.1:${env.port}/health`, {
    headers: { Origin: 'https://alidocs.dingtalk.com' },
  }).then((res) => res.json())) as HealthPayload;
  expect(allowed.ok).toBe(true);
  expect(allowed.originAllowed).toBe(true);
  expect(allowed.port).toBe(env.port);
  expect(allowed.connected).toBe(false);

  const rejected = (await fetch(`http://127.0.0.1:${env.port}/health`, {
    headers: { Origin: 'https://evil.com' },
  }).then((res) => res.json())) as HealthPayload;
  expect(rejected.originAllowed).toBe(false);
  // 白名单外不得泄露指纹字段
  expect(rejected.port).toBe(undefined);
  expect(rejected.connected).toBe(undefined);
  expect(rejected.allowWrite).toBe(undefined);
});

// ---- 建桥后的转发链路 ----

it('建桥后 bridge 主动 initialize 页面并通知 host 刷新工具列表', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  // readyOf 断言握手成功（否则抛错），返回 ready 控制消息
  expect(readyOf(page).allowWrite).toBe(false);

  await env.host.waitNotification('notifications/tools/list_changed');

  await waitUntil(
    () => page.requests.some((request) => request.method === 'initialize'),
    '页面收到 initialize',
  );
  await waitUntil(
    () =>
      page.requests.some(
        (request) => request.method === 'notifications/initialized',
      ),
    '页面收到 initialized 通知',
  );
  expect(env.bridge.router.pageReady).toBe(true);
});

it('tools/list 合并 bridge 本地工具与页面工具', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  await connectFakePage({
    port: env.port,
    pairingCode,
    tools: [
      {
        name: 'read_document',
        description: 'read',
        inputSchema: { type: 'object' },
      },
      {
        name: 'update_block',
        description: 'write',
        inputSchema: { type: 'object' },
      },
    ],
  });
  await env.host.waitNotification('notifications/tools/list_changed');

  const response = await env.host.request('tools/list', {});
  const { tools } = resultOf<ToolsListResult>(response);
  expect(tools.map((tool) => tool.name)).toEqual([
    'get_pairing_code',
    'get_bridge_status',
    'revoke_session',
    'call_page_tool',
    'list_page_tools',
    'read_document',
    'update_block',
  ]);
});

it('tools/call 透传到页面并把结果原样回给 host（id 重映射）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage & { docmcp?: number };
    if (message.docmcp || !message.method) return;
    page.requests.push(message);
    if (message.method === 'tools/call') {
      const args = (message.params?.arguments ?? {}) as { uuid?: string };
      page.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `read:${args.uuid}` }],
        },
      });
    }
  };

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: { uuid: 'block-1' },
  });
  expect(resultOf<ToolCallResult>(response).content[0]?.text).toBe(
    'read:block-1',
  );
  expect(String(response.id)).toMatch(/^host-\d+$/);

  const forwarded = page.requests.find(
    (request) => request.method === 'tools/call',
  );
  expect(forwarded?.id).not.toBe(response.id);
  expect(String(forwarded?.id)).toMatch(/^h\d+$/);
});

it('call_page_tool 把调用原样转发给页面并返回结果', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage & { docmcp?: number };
    if (message.docmcp || !message.method) return;
    page.requests.push(message);
    if (message.method === 'tools/call') {
      const params = message.params as {
        name?: string;
        arguments?: { uuid?: string };
      };
      page.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: `via-proxy:${params.name}:${params.arguments?.uuid}`,
            },
          ],
        },
      });
    }
  };

  const response = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: { name: 'read_document', arguments: { uuid: 'block-2' } },
  });
  expect(resultOf<ToolCallResult>(response).content[0]?.text).toBe(
    'via-proxy:read_document:block-2',
  );

  const forwarded = page.requests.find(
    (request) => request.method === 'tools/call',
  );
  if (!forwarded) throw new Error('未收到 tools/call 转发');
  const params = forwarded.params;
  if (!params) throw new Error('转发请求缺少 params');
  expect(params.name).toBe('read_document');
  expect((params.arguments as { uuid: string }).uuid).toBe('block-2');
});

it('call_page_tool 转发页面工具返回的 isError 结果', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage & { docmcp?: number };
    if (message.docmcp || !message.method) return;
    if (message.method === 'tools/call') {
      page.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'page says no' }],
          structuredContent: { ok: false, code: 'PAGE_DENIED' },
        },
      });
    }
  };

  const response = await env.host.request('tools/call', {
    name: 'call_page_tool',
    arguments: { name: 'update_block', arguments: {} },
  });
  const result = resultOf<ToolCallResult<{ code: string }>>(response);
  expect(result.isError).toBe(true);
  expect(result.structuredContent?.code).toBe('PAGE_DENIED');
});

it('页面侧通知原样上抛 host', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.sendJson({
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri: 'document://current/selection' },
  });

  const notification = await env.host.waitFor(
    (message) => message.method === 'notifications/resources/updated',
    'resources/updated',
  );
  expect(notification.params?.uri).toBe('document://current/selection');
});

// ---- 断桥 / 重连 / 单会话 / 撤销 ----

it('断桥时在途请求立即收到结构化错误，不挂起', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage;
    if (message.method === 'tools/call') page.client.close(1001, 'page reload');
  };

  const id = 'inflight-1';
  env.host.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'read_document', arguments: {} },
  });

  const response = await env.host.waitFor(
    (message) => message.id === id,
    '断桥错误响应',
  );
  const error = errorOf(response);
  expect(error.code).toBe(-32001);
  expect(error.data.code).toBe('PAGE_DISCONNECTED');
  expect(error.data.hint).toMatch(/get_pairing_code/);
});

it('刷新后用同一配对码重连即恢复（sessionStorage 语义）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  // 同一配对码贯穿两次连接（模拟页面刷新后从 sessionStorage 取回 secret 重连）
  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');
  page1.client.close(1001, 'reload');
  await waitUntil(() => !env.bridge.sessions.connected, '会话已断开');

  const page2 = await connectFakePage({ port: env.port, pairingCode });
  expect(readyOf(page2).sessionId).toBeTruthy();

  page2.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage;
    if (message.method === 'tools/call') {
      page2.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'recovered' }] },
      });
    }
  };

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: {},
  });
  expect(resultOf<ToolCallResult>(response).content[0]?.text).toBe('recovered');
});

it('S8：新桥顶掉旧桥（旧连接收到 4008）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  readyOf(page1);

  const page2 = await connectFakePage({ port: env.port, pairingCode });
  const ready2 = readyOf(page2);

  const closed = await page1.client.waitClose();
  expect(closed.code).toBe(4008);
  expect(env.bridge.sessions.current?.id).toBe(ready2.sessionId);
});

it('S11：revoke_session 轮换密钥后旧配对码失效', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  readyOf(page1);

  // 撤销
  const revoke = await env.host.request('tools/call', {
    name: 'revoke_session',
    arguments: {},
  });
  expect(structuredOf<RevokeStatus>(revoke).revoked).toBe(true);
  await waitUntil(() => !env.bridge.sessions.connected, '撤销后会话断开');

  // 旧配对码再连必被拒（mac 用旧 secret 算，与新 secret 不匹配）
  const page2 = await connectFakePage({ port: env.port, pairingCode });
  expect(handshakeErrorOf(page2).code).toBe('AUTH_FAILED');

  // 取新配对码可重新连上
  const again = await fetchPairingCode(env.host);
  expect(again.pairingCode).not.toBe(pairingCode);
  const page3 = await connectFakePage({
    port: env.port,
    pairingCode: again.pairingCode,
  });
  readyOf(page3);
});

it('页面响应超时返回 PAGE_TIMEOUT 并向页面发取消通知', async () => {
  const env = await startTestBridge({ requestTimeoutMs: 150 });
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage & { docmcp?: number };
    if (!message.docmcp) page.requests.push(message);
    // 故意不应答 tools/call
  };

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: {},
  });
  expect(errorOf(response).data.code).toBe('PAGE_TIMEOUT');

  await waitUntil(
    () =>
      page.requests.some(
        (request) => request.method === 'notifications/cancelled',
      ),
    '取消通知已下发',
  );
});

// ---- 状态与审计 ----

it('get_bridge_status 反映建桥前后的状态', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const before = await env.host.request('tools/call', {
    name: 'get_bridge_status',
    arguments: {},
  });
  const beforeStatus = structuredOf<BridgeStatus>(before);
  expect(beforeStatus.connected).toBe(false);
  expect(beforeStatus.hint).toMatch(/get_pairing_code/);

  const { pairingCode } = await fetchPairingCode(env.host);
  await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  const after = await env.host.request('tools/call', {
    name: 'get_bridge_status',
    arguments: {},
  });
  const status = structuredOf<BridgeStatus>(after);
  expect(status.connected).toBe(true);
  expect(status.pageReady).toBe(true);
  expect(status.session?.origin).toBe('https://alidocs.dingtalk.com');
  expect(
    status.allowedOrigins.includes('https://alidocs.dingtalk.com'),
  ).toBeTruthy();
});

it('S9：审计日志记录会话与工具调用，且不含配对码与参数值', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text) as HostMessage;
    if (message.method === 'tools/call') {
      page.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [] },
      });
    }
  };
  await env.host.request('tools/call', {
    name: 'read_document',
    arguments: { uuid: 'secret-block-uuid' },
  });

  const entries = env.readAudit();
  const events = entries.map((entry) => entry.event);
  expect(events.includes('bridge.start')).toBeTruthy();
  expect(events.includes('pairing.issued')).toBeTruthy();
  expect(events.includes('session.open')).toBeTruthy();
  expect(events.includes('tool.call')).toBeTruthy();

  const toolCall = entries.find(
    (entry) => entry.event === 'tool.call' && entry.tool === 'read_document',
  );
  expect(toolCall?.argKeys).toEqual(['uuid']);
  expect(toolCall?.target).toBe('page');

  const raw = JSON.stringify(entries);
  expect(!raw.includes(pairingCode)).toBeTruthy();
  expect(!raw.includes('secret-block-uuid')).toBeTruthy();
});

it('ping 由 bridge 本地应答（页面不在也能保活）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('ping', {});
  expect(response.result).toEqual({});
});

it('resources/read 在未建桥时返回结构化 JSON-RPC 错误', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('resources/read', {
    uri: 'document://current/selection',
  });
  const error = errorOf(response);
  expect(error.code).toBe(-32001);
  expect(error.data.code).toBe('PAGE_NOT_CONNECTED');
});

// ---- v3 版本协商与宿主画像（B1）----

it('challenge 携带桥支持区间；无区间的 v2 页面协商到 2', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson<ChallengeMessage>();
  expect(challenge.protocolMin).toBe(2);
  expect(challenge.protocolMax).toBe(3);
  expect(typeof challenge.bridgeVersion).toBe('string');

  const mac = computeMac(pairingCode, challenge.nonce);
  // 老 v2 页面：docmcp=2 且不带 protocolMin/Max
  client.sendJson({ docmcp: 2, type: 'auth', mac, client: {} });
  const ready = await client.nextJson<ReadyMessage>();
  expect(ready.type).toBe(CONTROL_TYPE.READY);
  expect(ready.protocol).toBe(2);
  expect(ready.docmcp).toBe(2);
});

it('声明 [3,3] 的 v3 页面协商到 3', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson<ChallengeMessage>();
  const mac = computeMac(pairingCode, challenge.nonce);
  client.sendJson({
    docmcp: 3,
    type: 'auth',
    mac,
    client: { protocolMin: 3, protocolMax: 3, connectorVersion: '2.0.0' },
  });
  const ready = await client.nextJson<ReadyMessage>();
  expect(ready.type).toBe(CONTROL_TYPE.READY);
  expect(ready.protocol).toBe(3);
});

it('页面比桥新（[4,4]）→ PROTOCOL_MISMATCH + 关闭码 4004（提示升级桥）', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson<ChallengeMessage>();
  const mac = computeMac(pairingCode, challenge.nonce);
  // mac 正确（持码真实页面），但协议区间超出桥支持窗口
  client.sendJson({
    docmcp: 4,
    type: 'auth',
    mac,
    client: { protocolMin: 4, protocolMax: 4 },
  });
  const reply = await client.nextJson<ErrorMessage>();
  expect(reply.type).toBe(CONTROL_TYPE.ERROR);
  expect(reply.code).toBe('PROTOCOL_MISMATCH');
  const closed = await client.waitClose();
  expect(closed.code).toBe(4004);

  const events = env.readAudit().map((entry) => entry.event);
  expect(events.includes('session.protocol.mismatch')).toBeTruthy();
});

it('host-profile=standard 隐藏静态兜底工具（call_page_tool / list_page_tools）', async () => {
  const env = await startTestBridge({ hostProfile: 'standard' });
  onTestFinished(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/list', {});
  const names = resultOf<ToolsListResult>(response).tools.map(
    (tool) => tool.name,
  );
  expect(names).not.toContain('call_page_tool');
  expect(names).not.toContain('list_page_tools');
  expect(names).toContain('get_pairing_code');
});

it('list_page_tools 以数据返回页面工具清单', async () => {
  const env = await startTestBridge();
  onTestFinished(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);
  await connectFakePage({
    port: env.port,
    pairingCode,
    tools: [
      {
        name: 'read_document',
        description: 'read',
        inputSchema: { type: 'object' },
      },
    ],
  });
  await env.host.waitNotification('notifications/tools/list_changed');

  const response = await env.host.request('tools/call', {
    name: 'list_page_tools',
    arguments: {},
  });
  const result =
    resultOf<ToolCallResult<{ ok: boolean; tools: { name: string }[] }>>(
      response,
    );
  expect(result.structuredContent?.ok).toBe(true);
  expect(result.structuredContent?.tools.map((tool) => tool.name)).toContain(
    'read_document',
  );
});
