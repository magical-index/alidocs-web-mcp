'use strict';

/**
 * 测试（单元）：WS 帧编解码 + Origin 白名单 + secret/HMAC 挑战-响应 + 协议一致性
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  OPCODE,
  encodeText,
  encodeClose,
  encodeFrame,
  createFrameParser,
} = require('../src/frames');
const { matchOrigin, isOriginAllowed, parseArgs, DEFAULT_ALLOWED_ORIGINS } = require('../src/config');
const { SecretStore } = require('../src/secrets');
const { computeMac, verifyMac } = require('../src/protocol/crypto');
const protocol = require('../src/protocol');

/** 协议一致性向量（单一真源，bridge 与 web 两侧均断言与此一致） */
const VECTORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'protocol', 'vectors.json'), 'utf8'),
);

// ---- frames ----

function collect(options) {
  const messages = [];
  const closes = [];
  const errors = [];
  const parser = createFrameParser({
    requireMask: options && options.requireMask,
    onMessage: ({ opcode, payload }) => messages.push({ opcode, text: payload.toString('utf8') }),
    onClose: (info) => closes.push(info),
    onError: (error) => errors.push(error),
  });
  return { parser, messages, closes, errors };
}

test('frames: 掩码文本帧可被解出原文', () => {
  const { parser, messages } = collect({ requireMask: true });
  parser.push(encodeText('hello 世界', { mask: true }));
  assert.deepStrictEqual(messages, [{ opcode: OPCODE.TEXT, text: 'hello 世界' }]);
});

test('frames: 分片消息按序重组', () => {
  const { parser, messages } = collect({ requireMask: true });
  parser.push(encodeFrame(OPCODE.TEXT, Buffer.from('{"a":'), { mask: true, fin: false }));
  parser.push(encodeFrame(OPCODE.CONTINUATION, Buffer.from('1}'), { mask: true, fin: true }));
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].text, '{"a":1}');
});

test('frames: 逐字节喂入也能解析（粘包/拆包）', () => {
  const { parser, messages } = collect({ requireMask: true });
  const frame = encodeText('x'.repeat(300), { mask: true });
  for (const byte of frame) parser.push(Buffer.from([byte]));
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].text.length, 300);
});

test('frames: 一次喂入多帧全部解析', () => {
  const { parser, messages } = collect({ requireMask: true });
  parser.push(Buffer.concat([encodeText('a', { mask: true }), encodeText('b', { mask: true })]));
  assert.deepStrictEqual(messages.map((m) => m.text), ['a', 'b']);
});

test('frames: close 帧带出状态码与原因', () => {
  const { parser, closes } = collect({ requireMask: true });
  parser.push(encodeClose(4003, 'AUTH_FAILED', { mask: true }));
  assert.deepStrictEqual(closes, [{ code: 4003, reason: 'AUTH_FAILED' }]);
});

test('frames: 客户端未掩码时报协议错误', () => {
  const { parser, errors } = collect({ requireMask: true });
  parser.push(encodeText('unmasked'));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].closeCode, 1002);
});

test('frames: 65536 字节以上走 64 位长度字段', () => {
  const { parser, messages } = collect({ requireMask: true });
  const big = 'y'.repeat(70000);
  parser.push(encodeText(big, { mask: true }));
  assert.strictEqual(messages[0].text.length, 70000);
});

// ---- origin 白名单（S2）----

test('origin: * 只匹配单个 label，不跨点', () => {
  assert.ok(matchOrigin('https://a.example.com', 'https://*.example.com'));
  assert.ok(!matchOrigin('https://a.b.dingtalk.com', 'https://*.example.com'));
  assert.ok(!matchOrigin('https://evil.com', 'https://*.example.com'));
});

test('origin: 默认白名单放行官方文档环境与本地开发域', () => {
  const allowed = [
    'https://alidocs.dingtalk.com',
    'https://pre-alidocs.dingtalk.com',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
  ];
  for (const origin of allowed) {
    assert.ok(isOriginAllowed(origin, DEFAULT_ALLOWED_ORIGINS), origin);
  }
});

test('origin: 默认**不**做 *.dingtalk.com 宽泛通配（未枚举的子域需显式放行）', () => {
  // 关键安全属性：白名单逐条枚举，任意子域不自动获得访问权
  assert.ok(!isOriginAllowed('https://docs.dingtalk.com', DEFAULT_ALLOWED_ORIGINS));
  assert.ok(!isOriginAllowed('https://untrusted.dingtalk.com', DEFAULT_ALLOWED_ORIGINS));

  const config = parseArgs(['--allow-origin', 'https://staging.example.com']);
  assert.ok(isOriginAllowed('https://staging.example.com', config.allowedOrigins));
});

test('origin: 恶意来源与空 Origin 一律拒绝', () => {
  const rejected = [
    'https://evil.com',
    'http://alidocs.dingtalk.com.evil.com',
    'https://dingtalk.com.evil.com',
    'null',
    '',
    undefined,
  ];
  for (const origin of rejected) {
    assert.ok(!isOriginAllowed(origin, DEFAULT_ALLOWED_ORIGINS), String(origin));
  }
});

// ---- CLI 参数 ----

test('config: 默认为固定端口候选集 + 只读 + 环回 bind', () => {
  const config = parseArgs([]);
  assert.deepStrictEqual(config.portCandidates, [19837, 19838, 19839]);
  assert.strictEqual(config.allowWrite, false);
  assert.strictEqual(config.host, '127.0.0.1');
});

test('config: --port 显式指定时候选集收敛为单元素', () => {
  const config = parseArgs(['--port', '20000']);
  assert.deepStrictEqual(config.portCandidates, [20000]);
});

test('config: --only-origin 完全替换默认白名单', () => {
  const config = parseArgs(['--only-origin', 'https://my.dev.local']);
  assert.deepStrictEqual(config.allowedOrigins, ['https://my.dev.local']);
  assert.ok(!isOriginAllowed('https://alidocs.dingtalk.com', config.allowedOrigins));
});

test('config: --allow-origin 追加而不替换', () => {
  const config = parseArgs(['--allow-origin', 'https://my.dev.local']);
  assert.ok(isOriginAllowed('https://alidocs.dingtalk.com', config.allowedOrigins));
  assert.ok(isOriginAllowed('https://my.dev.local', config.allowedOrigins));
});

test('config: 未知参数与非法端口直接报错', () => {
  assert.throws(() => parseArgs(['--bind', '0.0.0.0']), /未知参数/);
  assert.throws(() => parseArgs(['--port', '99999']), /--port 非法/);
});

// ---- secret / 挑战-响应（S3 / S10 / S11）----

test('secret: 初始生成 256bit 配对码，rotate 后旧码失效', () => {
  const store = new SecretStore();
  const first = store.pairingCode;
  assert.strictEqual(first.length, 64);
  const nonce = 'abc123';
  const mac = computeMac(first, nonce);
  assert.strictEqual(store.verify(nonce, mac), true);

  store.rotate();
  assert.notStrictEqual(store.pairingCode, first);
  assert.strictEqual(store.verify(nonce, mac), false); // 旧码对新 secret 不成立
});

test('secret: 错误/缺失 mac 一律不通过', () => {
  const store = new SecretStore({ generate: () => 'a'.repeat(64) });
  assert.strictEqual(store.verify('n', 'f'.repeat(64)), false);
  assert.strictEqual(store.verify('n', ''), false);
  assert.strictEqual(store.verify('n', undefined), false);
});

test('handshakeCrypto: computeMac 命中固定向量（须与页面侧一致）', () => {
  const v = VECTORS.macVector;
  assert.strictEqual(computeMac(v.secret, v.nonce), v.expectedMac);
});

test('handshakeCrypto: verifyMac 常量时间校验', () => {
  const v = VECTORS.macVector;
  assert.strictEqual(verifyMac(v.secret, v.nonce, v.expectedMac), true);
  assert.strictEqual(verifyMac(v.secret, v.nonce, 'deadbeef'), false);
});

// ---- 协议一致性（防 bridge / web drift）----

test('protocol: bridge 侧常量与向量 JSON 逐字一致', () => {
  assert.strictEqual(protocol.PROTOCOL_VERSION, VECTORS.protocolVersion);
  assert.strictEqual(protocol.SERVICE_ID, VECTORS.serviceId);
  assert.strictEqual(protocol.MAC_ALGORITHM, VECTORS.macAlgorithm);
  assert.deepStrictEqual(protocol.CONTROL_TYPE, VECTORS.controlType);
  assert.deepStrictEqual(protocol.CLOSE_CODE, VECTORS.closeCode);
  assert.deepStrictEqual(protocol.ERROR_CODE, VECTORS.errorCode);
});

test('protocol: 控制消息构造器与类型守卫', () => {
  const challenge = protocol.makeChallenge('n1');
  assert.strictEqual(protocol.isControlMessage(challenge), true);
  assert.strictEqual(challenge.type, 'challenge');
  assert.strictEqual(protocol.isControlMessage({ jsonrpc: '2.0', id: 1 }), false);
  assert.strictEqual(protocol.isControlMessage(null), false);
});
