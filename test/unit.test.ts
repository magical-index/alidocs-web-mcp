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
import {
  PAIRING_CODE_SEPARATOR,
  formatPairingCode,
  parsePairingCode,
} from '../src/protocol/pairingCode.ts';
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
  pairingCode: {
    separator: string;
    portPattern: string;
    portMax: number;
    secretMustNotContainSeparator: boolean;
    cases: Array<{
      code: string;
      port: number | null;
      secret: string;
      why: string;
    }>;
  };
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

  // TDD RED：多实例场景（slug mcp-bridge-port-in-pairing-code，验收 A2）
  it('--port 0 表示让 OS 分配临时端口（多实例的正解）', () => {
    // 端口不再是实例标识（配对码已含端口），所以「随便给一个能用的端口」才是默认最优。
    // listen(0) 下游已支持：wsServer 的候选集为空时退化为 [0]，onListening 回真实端口。
    expect(parseArgs(['--port', '0']).portCandidates).toEqual([0]);
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
    // 放开 0 之后，负数与非整数仍必须报错（放开的只有 0 这一个取值）
    expect(() => parseArgs(['--port', '-1'])).toThrow(/--port 非法/);
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port 非法/);
    expect(() => parseArgs(['--port', '1.5'])).toThrow(/--port 非法/);
  });
});

/**
 * TDD RED：配对码复合 token（slug mcp-bridge-port-in-pairing-code）
 *
 * 契约来源：we-word `specs/mcp-bridge-port-in-pairing-code.md` §2
 * 桥生产链路上只用 formatPairingCode；parsePairingCode 是它的后置条件的可测形式，
 * 也是向量的参考实现（与 computeMac / macVector 的既有格局同构：两仓各一份实现，靠向量对齐）。
 */
describe('配对码 <port>.<secret>（S10 不变：明文只在本机数据面）', () => {
  const S64 = 'a'.repeat(64);

  it('分隔符与向量声明一致', () => {
    expect(PAIRING_CODE_SEPARATOR).toBe('.');
    expect(PAIRING_CODE_SEPARATOR).toBe(VECTORS.pairingCode.separator);
  });

  it('format 正常拼装', () => {
    expect(formatPairingCode(19837, S64)).toBe(`19837.${S64}`);
    expect(formatPairingCode(1, S64)).toBe(`1.${S64}`);
    expect(formatPairingCode(65535, S64)).toBe(`65535.${S64}`);
  });

  it('SecretStore 生成的 secret 结构上不含分隔符（第一个 `.` 处切分才成立）', () => {
    // 页面敢在第一个分隔符处切，依据就是这条：randomBytes(32).toString('hex') → [0-9a-f]{64}
    for (let i = 0; i < 20; i += 1) {
      expect(new SecretStore().pairingCode).not.toContain(
        PAIRING_CODE_SEPARATOR,
      );
    }
  });

  it('format 前置条件违反 → 抛（编程错误，与 parse 的 fail-soft 刻意不对称）', () => {
    expect(() => formatPairingCode(0, S64)).toThrow();
    expect(() => formatPairingCode(-1, S64)).toThrow();
    expect(() => formatPairingCode(65536, S64)).toThrow();
    expect(() => formatPairingCode(1.5, S64)).toThrow();
    expect(() => formatPairingCode(19837, '')).toThrow();
    // secret 里含分隔符会让页面切错，宁可在生成侧炸掉
    expect(() => formatPairingCode(19837, 'a.b')).toThrow();
  });

  it('parse 遍历向量用例表（与页面侧同一份 cases）', () => {
    expect(VECTORS.pairingCode.cases.length).toBeGreaterThanOrEqual(12);
    for (const c of VECTORS.pairingCode.cases) {
      expect(parsePairingCode(c.code), c.why).toEqual({
        port: c.port,
        secret: c.secret,
      });
    }
  });

  it('parse(format(port, secret)) 往返恒等（§2.2 后置条件）', () => {
    for (const c of VECTORS.pairingCode.cases) {
      if (c.port === null) continue;
      expect(formatPairingCode(c.port, c.secret)).toBe(c.code);
      expect(parsePairingCode(c.code)).toEqual({
        port: c.port,
        secret: c.secret,
      });
    }
  });

  it('parse 永不抛（页面侧 INV-3 的同源约束）', () => {
    for (const code of ['', '.', '..', '19837.', `.${S64}`, '0.x', 'abc.x']) {
      expect(() => parsePairingCode(code)).not.toThrow();
      expect(typeof parsePairingCode(code).secret).toBe('string');
    }
  });

  it('向量声明的端口正则禁前导零（`019837` 不得被解析成 1983）', () => {
    expect(VECTORS.pairingCode.portPattern).toBe('^[1-9][0-9]{0,4}$');
    expect(VECTORS.pairingCode.portMax).toBe(65535);
    expect(parsePairingCode(`019837.${S64}`).port).toBeNull();
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
