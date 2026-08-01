'use strict';

/**
 * 测试：bridge 端到端链路（stdio ↔ WS）· 方案 C′
 *
 * 覆盖：
 * - initialize → tools/list（含页面工具）→ tools/call 透传真实结果
 * - 断桥后返回结构化错误而非挂起；重新配对恢复
 * - 恶意 Origin / 错误 mac 被拒（挑战-响应）
 * - 单连接会话制（新桥顶掉旧桥）、握手超时、/health Origin 分级、审计日志
 * - revoke_session 轮换密钥后旧配对码失效
 */

const test = require('node:test');
const assert = require('node:assert');

const { connectWs } = require('./helpers/wsClient');
const { computeMac } = require('../src/protocol/crypto');
const { SERVICE_ID } = require('../src/protocol/index');
const {
  startTestBridge,
  initializeHost,
  fetchPairingCode,
  connectFakePage,
  waitUntil,
} = require('./helpers/harness');

// ---- 会话与工具发现 ----

test('initialize 返回 bridge 自身的 serverInfo 与 tools 能力', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  const response = await initializeHost(env.host, '2025-06-18');
  assert.strictEqual(response.result.protocolVersion, '2025-06-18');
  assert.strictEqual(response.result.serverInfo.name, SERVICE_ID);
  assert.strictEqual(response.result.capabilities.tools.listChanged, true);
  assert.match(response.result.instructions, /get_pairing_code/);
});

test('initialize 对不支持的协议版本回落到最新版本', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  const response = await initializeHost(env.host, '1999-01-01');
  assert.strictEqual(response.result.protocolVersion, '2025-06-18');
});

test('未建桥时 tools/list 只有 bridge 自有工具', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/list', {});
  assert.deepStrictEqual(
    response.result.tools.map((tool) => tool.name),
    ['get_pairing_code', 'get_bridge_status', 'revoke_session'],
  );
});

test('未建桥时调用文档工具返回 isError + PAGE_NOT_CONNECTED（不挂起）', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: {},
  });
  assert.strictEqual(response.result.isError, true);
  assert.strictEqual(response.result.structuredContent.code, 'PAGE_NOT_CONNECTED');
  assert.match(response.result.content[0].text, /get_pairing_code/);
});

test('get_pairing_code 返回配对码数据（非脚本），默认只读', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { response, pairingCode } = await fetchPairingCode(env.host);
  const sc = response.result.structuredContent;
  assert.strictEqual(sc.port, env.port);
  assert.strictEqual(sc.allowWrite, false);
  assert.strictEqual(sc.pairingCode, pairingCode);
  assert.strictEqual(pairingCode.length, 64); // 256-bit hex
  // S13：返回的是数据，不含可执行脚本
  const text = JSON.stringify(response.result);
  assert.ok(!/=>/.test(text), '不得返回箭头函数脚本');
  assert.ok(!/evaluate_script/.test(text), '不得引导 eval');
});

test('--allow-write 控制 allowWrite 标志', async (t) => {
  const roEnv = await startTestBridge();
  t.after(() => roEnv.stop());
  await initializeHost(roEnv.host);
  const ro = await fetchPairingCode(roEnv.host);
  assert.strictEqual(ro.response.result.structuredContent.allowWrite, false);

  const rwEnv = await startTestBridge({ allowWrite: true });
  t.after(() => rwEnv.stop());
  await initializeHost(rwEnv.host);
  const rw = await fetchPairingCode(rwEnv.host);
  assert.strictEqual(rw.response.result.structuredContent.allowWrite, true);
});

// ---- 安全：bind / Origin / 挑战-响应 ----

test('S1：socket 只 bind 在环回地址上', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  const address = env.bridge.wsServer.server.address();
  assert.strictEqual(address.address, '127.0.0.1');
  assert.strictEqual(env.config.host, '127.0.0.1');
});

test('端口取自固定候选集', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  assert.ok(env.config.portCandidates.includes(env.port));
});

test('S2：恶意 Origin 在 upgrade 阶段被 403 拒绝', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  await assert.rejects(
    () => connectWs({ port: env.port, origin: 'https://evil.com' }),
    (error) => {
      assert.strictEqual(error.status, 403);
      assert.strictEqual(error.rejectReason, 'ORIGIN_REJECTED');
      return true;
    },
  );

  const events = env.readAudit().map((entry) => entry.event);
  assert.ok(events.includes('ws.upgrade.rejected'));
});

test('S2：缺失 Origin 头同样被拒', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  await assert.rejects(() => connectWs({ port: env.port }), (error) => {
    assert.strictEqual(error.status, 403);
    return true;
  });
});

test('S10：Origin 合法但 mac 错误 → error + 4003 关闭', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson();
  assert.strictEqual(challenge.type, 'challenge');
  client.sendJson({ docmcp: 2, type: 'auth', mac: 'f'.repeat(64), client: {} });

  const reply = await client.nextJson();
  assert.strictEqual(reply.type, 'error');
  assert.strictEqual(reply.code, 'AUTH_FAILED');

  const closed = await client.waitClose();
  assert.strictEqual(closed.code, 4003);

  const events = env.readAudit().map((entry) => entry.event);
  assert.ok(events.includes('session.auth.failed'));
});

test('S10：mac 由 secret+nonce 派生，secret 明文永不上线', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);
  const { pairingCode } = await fetchPairingCode(env.host);

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  const challenge = await client.nextJson();
  // 页面发出的 auth 帧里只有 mac，没有配对码本身
  const mac = computeMac(pairingCode, challenge.nonce);
  client.sendJson({ docmcp: 2, type: 'auth', mac, client: {} });
  const ready = await client.nextJson();
  assert.strictEqual(ready.type, 'ready');
  // 上线的消息里不得出现配对码明文
  assert.ok(!client.messages.some((m) => m.includes(pairingCode)));
});

test('握手超时未发 auth 的连接被 4009 关闭', async (t) => {
  const env = await startTestBridge({ handshakeTimeoutMs: 120 });
  t.after(() => env.stop());

  const client = await connectWs({
    port: env.port,
    origin: 'https://alidocs.dingtalk.com',
  });
  await client.nextJson(); // challenge
  const closed = await client.waitClose();
  assert.strictEqual(closed.code, 4009);
});

test('S7：/health 对白名单内/外分级返回', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());

  const allowed = await fetch(`http://127.0.0.1:${env.port}/health`, {
    headers: { Origin: 'https://alidocs.dingtalk.com' },
  }).then((res) => res.json());
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.originAllowed, true);
  assert.strictEqual(allowed.port, env.port);
  assert.strictEqual(allowed.connected, false);

  const rejected = await fetch(`http://127.0.0.1:${env.port}/health`, {
    headers: { Origin: 'https://evil.com' },
  }).then((res) => res.json());
  assert.strictEqual(rejected.originAllowed, false);
  // 白名单外不得泄露指纹字段
  assert.strictEqual(rejected.port, undefined);
  assert.strictEqual(rejected.connected, undefined);
  assert.strictEqual(rejected.allowWrite, undefined);
});

// ---- 建桥后的转发链路 ----

test('建桥后 bridge 主动 initialize 页面并通知 host 刷新工具列表', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page.ready.type, 'ready');
  assert.strictEqual(page.ready.allowWrite, false);

  await env.host.waitNotification('notifications/tools/list_changed');

  await waitUntil(
    () => page.requests.some((request) => request.method === 'initialize'),
    '页面收到 initialize',
  );
  await waitUntil(
    () => page.requests.some((request) => request.method === 'notifications/initialized'),
    '页面收到 initialized 通知',
  );
  assert.strictEqual(env.bridge.router.pageReady, true);
});

test('tools/list 合并 bridge 本地工具与页面工具', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  await connectFakePage({
    port: env.port,
    pairingCode,
    tools: [
      { name: 'read_document', description: 'read', inputSchema: { type: 'object' } },
      { name: 'update_block', description: 'write', inputSchema: { type: 'object' } },
    ],
  });
  await env.host.waitNotification('notifications/tools/list_changed');

  const response = await env.host.request('tools/list', {});
  assert.deepStrictEqual(
    response.result.tools.map((tool) => tool.name),
    ['get_pairing_code', 'get_bridge_status', 'revoke_session', 'read_document', 'update_block'],
  );
});

test('tools/call 透传到页面并把结果原样回给 host（id 重映射）', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.docmcp || !message.method) return;
    page.requests.push(message);
    if (message.method === 'tools/call') {
      page.client.sendJson({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `read:${message.params.arguments.uuid}` }],
        },
      });
    }
  };

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: { uuid: 'block-1' },
  });
  assert.strictEqual(response.result.content[0].text, 'read:block-1');
  assert.match(String(response.id), /^host-\d+$/);

  const forwarded = page.requests.find((request) => request.method === 'tools/call');
  assert.notStrictEqual(forwarded.id, response.id);
  assert.match(String(forwarded.id), /^h\d+$/);
});

test('页面侧通知原样上抛 host', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
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
  assert.strictEqual(notification.params.uri, 'document://current/selection');
});

// ---- 断桥 / 重连 / 单会话 / 撤销 ----

test('断桥时在途请求立即收到结构化错误，不挂起', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.method === 'tools/call') page.client.close(1001, 'page reload');
  };

  const id = 'inflight-1';
  env.host.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'read_document', arguments: {} },
  });

  const response = await env.host.waitFor((message) => message.id === id, '断桥错误响应');
  assert.strictEqual(response.error.code, -32001);
  assert.strictEqual(response.error.data.code, 'PAGE_DISCONNECTED');
  assert.match(response.error.data.hint, /get_pairing_code/);
});

test('刷新后用同一配对码重连即恢复（sessionStorage 语义）', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  // 同一配对码贯穿两次连接（模拟页面刷新后从 sessionStorage 取回 secret 重连）
  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');
  page1.client.close(1001, 'reload');
  await waitUntil(() => !env.bridge.sessions.connected, '会话已断开');

  const page2 = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page2.ready.type, 'ready');

  page2.client.onmessage = (text) => {
    const message = JSON.parse(text);
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
  assert.strictEqual(response.result.content[0].text, 'recovered');
});

test('S8：新桥顶掉旧桥（旧连接收到 4008）', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page1.ready.type, 'ready');

  const page2 = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page2.ready.type, 'ready');

  const closed = await page1.client.waitClose();
  assert.strictEqual(closed.code, 4008);
  assert.strictEqual(env.bridge.sessions.current.id, page2.ready.sessionId);
});

test('S11：revoke_session 轮换密钥后旧配对码失效', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page1 = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page1.ready.type, 'ready');

  // 撤销
  const revoke = await env.host.request('tools/call', {
    name: 'revoke_session',
    arguments: {},
  });
  assert.strictEqual(revoke.result.structuredContent.revoked, true);
  await waitUntil(() => !env.bridge.sessions.connected, '撤销后会话断开');

  // 旧配对码再连必被拒（mac 用旧 secret 算，与新 secret 不匹配）
  const page2 = await connectFakePage({ port: env.port, pairingCode });
  assert.strictEqual(page2.ready.type, 'error');
  assert.strictEqual(page2.ready.code, 'AUTH_FAILED');

  // 取新配对码可重新连上
  const again = await fetchPairingCode(env.host);
  assert.notStrictEqual(again.pairingCode, pairingCode);
  const page3 = await connectFakePage({ port: env.port, pairingCode: again.pairingCode });
  assert.strictEqual(page3.ready.type, 'ready');
});

test('页面响应超时返回 PAGE_TIMEOUT 并向页面发取消通知', async (t) => {
  const env = await startTestBridge({ requestTimeoutMs: 150 });
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text);
    if (!message.docmcp) page.requests.push(message);
    // 故意不应答 tools/call
  };

  const response = await env.host.request('tools/call', {
    name: 'read_document',
    arguments: {},
  });
  assert.strictEqual(response.error.data.code, 'PAGE_TIMEOUT');

  await waitUntil(
    () => page.requests.some((request) => request.method === 'notifications/cancelled'),
    '取消通知已下发',
  );
});

// ---- 状态与审计 ----

test('get_bridge_status 反映建桥前后的状态', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const before = await env.host.request('tools/call', {
    name: 'get_bridge_status',
    arguments: {},
  });
  assert.strictEqual(before.result.structuredContent.connected, false);
  assert.match(before.result.structuredContent.hint, /get_pairing_code/);

  const { pairingCode } = await fetchPairingCode(env.host);
  await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  const after = await env.host.request('tools/call', {
    name: 'get_bridge_status',
    arguments: {},
  });
  const status = after.result.structuredContent;
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.pageReady, true);
  assert.strictEqual(status.session.origin, 'https://alidocs.dingtalk.com');
  assert.ok(status.allowedOrigins.includes('https://alidocs.dingtalk.com'));
});

test('S9：审计日志记录会话与工具调用，且不含配对码与参数值', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const { pairingCode } = await fetchPairingCode(env.host);
  const page = await connectFakePage({ port: env.port, pairingCode });
  await env.host.waitNotification('notifications/tools/list_changed');

  page.client.onmessage = (text) => {
    const message = JSON.parse(text);
    if (message.method === 'tools/call') {
      page.client.sendJson({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
    }
  };
  await env.host.request('tools/call', {
    name: 'read_document',
    arguments: { uuid: 'secret-block-uuid' },
  });

  const entries = env.readAudit();
  const events = entries.map((entry) => entry.event);
  assert.ok(events.includes('bridge.start'));
  assert.ok(events.includes('pairing.issued'));
  assert.ok(events.includes('session.open'));
  assert.ok(events.includes('tool.call'));

  const toolCall = entries.find((entry) => entry.event === 'tool.call' && entry.tool === 'read_document');
  assert.deepStrictEqual(toolCall.argKeys, ['uuid']);
  assert.strictEqual(toolCall.target, 'page');

  const raw = JSON.stringify(entries);
  assert.ok(!raw.includes(pairingCode), '审计日志不得含配对码');
  assert.ok(!raw.includes('secret-block-uuid'), '审计日志不得含参数值');
});

test('ping 由 bridge 本地应答（页面不在也能保活）', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('ping', {});
  assert.deepStrictEqual(response.result, {});
});

test('resources/read 在未建桥时返回结构化 JSON-RPC 错误', async (t) => {
  const env = await startTestBridge();
  t.after(() => env.stop());
  await initializeHost(env.host);

  const response = await env.host.request('resources/read', {
    uri: 'document://current/selection',
  });
  assert.strictEqual(response.error.code, -32001);
  assert.strictEqual(response.error.data.code, 'PAGE_NOT_CONNECTED');
});
