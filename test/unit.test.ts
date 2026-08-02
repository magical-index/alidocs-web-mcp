/**
 * 单元测试：WS 帧编解码 + Origin 白名单 + secret/HMAC 挑战-响应 + 协议一致性。
 *
 * 直接测 `src/`：类型受检，改坏签名会在测试里立刻暴露。
 * 发布产物的形状另由 `check:package`（publint + attw）与 artifact smoke 保证。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  OPCODE,
  encodeText,
  encodeClose,
  encodeFrame,
  createFrameParser,
  type FrameError,
  type CloseInfo,
} from '../src/frames.ts';
import {
  matchOrigin,
  isOriginAllowed,
  parseArgs,
  DEFAULT_ALLOWED_ORIGINS,
} from '../src/config.ts';
import { SecretStore } from '../src/secrets.ts';
import { computeMac, verifyMac } from '../src/protocol/crypto.ts';
import * as protocol from '../src/protocol/index.ts';

/** 协议一致性向量（单一真源，bridge 与页面侧均断言与此一致） */
const VECTORS = JSON.parse(
  readFileSync(
    new URL('../src/protocol/vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  protocolVersion: number;
  serviceId: string;
  macAlgorithm: string;
  controlType: Record<string, string>;
  closeCode: Record<string, number>;
  errorCode: Record<string, string>;
  macVector: { secret: string; nonce: string; expectedMac: string };
};

function collect(options?: { requireMask?: boolean }) {
  const messages: { opcode: number; text: string }[] = [];
  const closes: CloseInfo[] = [];
  const errors: FrameError[] = [];
  const parser = createFrameParser({
    requireMask: options?.requireMask,
    onMessage: ({ opcode, payload }) =>
      messages.push({ opcode, text: payload.toString('utf8') }),
    onClose: (info) => closes.push(info),
    onError: (error) => errors.push(error),
  });
  return { parser, messages, closes, errors };
}

describe('frames（WS 帧编解码，攻击面最大处）', () => {
  it('掩码文本帧可被解出原文', () => {
    const { parser, messages } = collect({ requireMask: true });
    parser.push(encodeText('hello 世界', { mask: true }));
    expect(messages).toEqual([{ opcode: OPCODE.TEXT, text: 'hello 世界' }]);
  });

  it('分片消息按序重组', () => {
    const { parser, messages } = collect({ requireMask: true });
    parser.push(
      encodeFrame(OPCODE.TEXT, Buffer.from('{"a":'), {
        mask: true,
        fin: false,
      }),
    );
    parser.push(
      encodeFrame(OPCODE.CONTINUATION, Buffer.from('1}'), {
        mask: true,
        fin: true,
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('{"a":1}');
  });

  it('逐字节喂入也能解析（粘包/拆包）', () => {
    const { parser, messages } = collect({ requireMask: true });
    const frame = encodeText('x'.repeat(300), { mask: true });
    for (const byte of frame) parser.push(Buffer.from([byte]));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toHaveLength(300);
  });

  it('一次喂入多帧全部解析', () => {
    const { parser, messages } = collect({ requireMask: true });
    parser.push(
      Buffer.concat([
        encodeText('a', { mask: true }),
        encodeText('b', { mask: true }),
      ]),
    );
    expect(messages.map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('close 帧带出状态码与原因', () => {
    const { parser, closes } = collect({ requireMask: true });
    parser.push(encodeClose(4003, 'AUTH_FAILED', { mask: true }));
    expect(closes).toEqual([{ code: 4003, reason: 'AUTH_FAILED' }]);
  });

  it('客户端未掩码时报协议错误', () => {
    const { parser, errors } = collect({ requireMask: true });
    parser.push(encodeText('unmasked'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.closeCode).toBe(1002);
  });

  it('65536 字节以上走 64 位长度字段', () => {
    const { parser, messages } = collect({ requireMask: true });
    parser.push(encodeText('y'.repeat(70000), { mask: true }));
    expect(messages[0]?.text).toHaveLength(70000);
  });
});

describe('origin 白名单（S2：恶意网页的唯一屏障）', () => {
  it('* 只匹配单个 label，不跨点', () => {
    expect(matchOrigin('https://a.example.com', 'https://*.example.com')).toBe(
      true,
    );
    expect(
      matchOrigin('https://a.b.example.com', 'https://*.example.com'),
    ).toBe(false);
    expect(matchOrigin('https://evil.com', 'https://*.example.com')).toBe(
      false,
    );
  });

  it('默认白名单放行官方文档环境与本地开发域', () => {
    for (const origin of [
      'https://alidocs.dingtalk.com',
      'https://pre-alidocs.dingtalk.com',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
    ]) {
      expect(isOriginAllowed(origin, DEFAULT_ALLOWED_ORIGINS), origin).toBe(
        true,
      );
    }
  });

  it('默认不做 *.dingtalk.com 宽泛通配（未枚举的子域需显式放行）', () => {
    // 关键安全属性：白名单逐条枚举，任意子域不自动获得访问权
    expect(
      isOriginAllowed('https://docs.dingtalk.com', DEFAULT_ALLOWED_ORIGINS),
    ).toBe(false);
    expect(
      isOriginAllowed(
        'https://untrusted.dingtalk.com',
        DEFAULT_ALLOWED_ORIGINS,
      ),
    ).toBe(false);

    const config = parseArgs(['--allow-origin', 'https://staging.example.com']);
    expect(
      isOriginAllowed('https://staging.example.com', config.allowedOrigins),
    ).toBe(true);
  });

  it('恶意来源与空 Origin 一律拒绝', () => {
    for (const origin of [
      'https://evil.com',
      'http://alidocs.dingtalk.com.evil.com',
      'https://dingtalk.com.evil.com',
      'null',
      '',
      undefined,
    ]) {
      expect(
        isOriginAllowed(origin, DEFAULT_ALLOWED_ORIGINS),
        String(origin),
      ).toBe(false);
    }
  });
});

describe('CLI 参数', () => {
  it('默认为固定端口候选集 + 只读 + 环回 bind', () => {
    const config = parseArgs([]);
    expect(config.portCandidates).toEqual([19837, 19838, 19839]);
    expect(config.allowWrite).toBe(false);
    expect(config.host).toBe('127.0.0.1');
  });

  it('--port 显式指定时候选集收敛为单元素', () => {
    expect(parseArgs(['--port', '20000']).portCandidates).toEqual([20000]);
  });

  it('--only-origin 完全替换默认白名单', () => {
    const config = parseArgs(['--only-origin', 'https://my.dev.local']);
    expect(config.allowedOrigins).toEqual(['https://my.dev.local']);
    expect(
      isOriginAllowed('https://alidocs.dingtalk.com', config.allowedOrigins),
    ).toBe(false);
  });

  it('--allow-origin 追加而不替换', () => {
    const config = parseArgs(['--allow-origin', 'https://my.dev.local']);
    expect(
      isOriginAllowed('https://alidocs.dingtalk.com', config.allowedOrigins),
    ).toBe(true);
    expect(isOriginAllowed('https://my.dev.local', config.allowedOrigins)).toBe(
      true,
    );
  });

  it('未知参数与非法端口直接报错', () => {
    expect(() => parseArgs(['--bind', '0.0.0.0'])).toThrow(/未知参数/);
    expect(() => parseArgs(['--port', '99999'])).toThrow(/--port 非法/);
  });
});

describe('secret / 挑战-响应（S3 / S10 / S11）', () => {
  it('初始生成 256bit 配对码，rotate 后旧码失效', () => {
    const store = new SecretStore();
    const first = store.pairingCode;
    expect(first).toHaveLength(64);

    const nonce = 'abc123';
    const mac = computeMac(first, nonce);
    expect(store.verify(nonce, mac)).toBe(true);

    store.rotate();
    expect(store.pairingCode).not.toBe(first);
    expect(store.verify(nonce, mac)).toBe(false); // 旧码对新 secret 不成立
  });

  it('错误/缺失 mac 一律不通过', () => {
    const store = new SecretStore({ generate: () => 'a'.repeat(64) });
    expect(store.verify('n', 'f'.repeat(64))).toBe(false);
    expect(store.verify('n', '')).toBe(false);
    expect(store.verify('n', undefined)).toBe(false);
  });

  it('computeMac 命中固定向量（须与页面侧一致）', () => {
    const v = VECTORS.macVector;
    expect(computeMac(v.secret, v.nonce)).toBe(v.expectedMac);
  });

  it('verifyMac 常量时间校验', () => {
    const v = VECTORS.macVector;
    expect(verifyMac(v.secret, v.nonce, v.expectedMac)).toBe(true);
    expect(verifyMac(v.secret, v.nonce, 'deadbeef')).toBe(false);
  });
});

describe('协议一致性（防 bridge / 页面侧 drift）', () => {
  it('bridge 侧常量与向量 JSON 逐字一致', () => {
    expect(protocol.PROTOCOL_VERSION).toBe(VECTORS.protocolVersion);
    expect(protocol.SERVICE_ID).toBe(VECTORS.serviceId);
    expect(protocol.MAC_ALGORITHM).toBe(VECTORS.macAlgorithm);
    expect(protocol.CONTROL_TYPE).toEqual(VECTORS.controlType);
    expect(protocol.CLOSE_CODE).toEqual(VECTORS.closeCode);
    expect(protocol.ERROR_CODE).toEqual(VECTORS.errorCode);
  });

  it('控制消息构造器与类型守卫', () => {
    const challenge = protocol.makeChallenge('n1');
    expect(protocol.isControlMessage(challenge)).toBe(true);
    expect(challenge.type).toBe('challenge');
    expect(protocol.isControlMessage({ jsonrpc: '2.0', id: 1 })).toBe(false);
    expect(protocol.isControlMessage(null)).toBe(false);
  });
});
