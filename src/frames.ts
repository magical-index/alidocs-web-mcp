/**
 * 最小 WebSocket 帧编解码（RFC 6455），零依赖。
 *
 * 只覆盖 bridge 需要的能力：text / binary / close / ping / pong，
 * 含分片（continuation）重组与掩码处理。控制帧不允许分片。
 *
 * 这是本项目攻击面最大的一处：所有长度字段、掩码、分片边界都必须显式校验，
 * 任何不足的数据都返回「等下次 push」而非越界读取。
 */

import * as crypto from 'node:crypto';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** 单帧最大 payload（防止恶意超大帧耗尽内存） */
export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024;
/** 分片重组后单消息最大长度 */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

export class FrameError extends Error {
  /** RFC 6455 关闭码：1002 协议错误 / 1009 消息过大 */
  readonly closeCode: number;

  constructor(message: string, closeCode?: number) {
    super(message);
    this.name = 'FrameError';
    this.closeCode = closeCode || 1002;
  }
}

export interface EncodeOptions {
  /** 仅客户端方向需要掩码 */
  mask?: boolean;
  fin?: boolean;
}

/** 编码一帧 */
export function encodeFrame(
  opcode: number,
  payload: Buffer | string,
  options?: EncodeOptions,
): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const mask = !!options?.mask;
  const fin = options?.fin === undefined ? true : !!options.fin;

  let lengthBytes: Buffer;
  if (body.length < 126) {
    lengthBytes = Buffer.from([body.length]);
  } else if (body.length < 65536) {
    lengthBytes = Buffer.alloc(3);
    lengthBytes[0] = 126;
    lengthBytes.writeUInt16BE(body.length, 1);
  } else {
    lengthBytes = Buffer.alloc(9);
    lengthBytes[0] = 127;
    lengthBytes.writeBigUInt64BE(BigInt(body.length), 1);
  }
  if (mask) lengthBytes[0] = (lengthBytes[0] as number) | 0x80;

  const header = Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0x00) | (opcode & 0x0f)]),
    lengthBytes,
  ]);

  if (!mask) return Buffer.concat([header, body]);

  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) {
    masked[i] = (body[i] as number) ^ (key[i % 4] as number);
  }
  return Buffer.concat([header, key, masked]);
}

/** 编码文本帧 */
export function encodeText(text: string, options?: EncodeOptions): Buffer {
  return encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'), options);
}

/** 编码 close 帧（带状态码与原因） */
export function encodeClose(
  code: number,
  reason?: string,
  options?: EncodeOptions,
): Buffer {
  const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
  payload.writeUInt16BE(code || 1000, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(OPCODE.CLOSE, payload, options);
}

export interface FrameMessage {
  opcode: number;
  payload: Buffer;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface FrameParserHandlers {
  onMessage: (data: FrameMessage) => void;
  onClose?: (info: CloseInfo) => void;
  onPing?: (payload: Buffer) => void;
  onPong?: (payload: Buffer) => void;
  onError: (error: FrameError) => void;
  /** 服务端接收客户端帧时必须要求掩码（默认 true） */
  requireMask?: boolean;
}

export interface FrameParser {
  /** 喂入新到达的字节 */
  push(chunk: Buffer | Uint8Array): void;
  /** 当前缓冲区剩余字节数（测试用） */
  readonly buffered: number;
}

interface Fragments {
  opcode: number;
  chunks: Buffer[];
  size: number;
}

/** 增量帧解析器：喂入字节流，回调完整消息 / 控制帧 */
export function createFrameParser(handlers: FrameParserHandlers): FrameParser {
  const requireMask = handlers.requireMask !== false;
  let buffer = Buffer.alloc(0);
  let fragments: Fragments | null = null;
  let failed = false;

  function fail(message: string, closeCode?: number): void {
    if (failed) return;
    failed = true;
    handlers.onError(new FrameError(message, closeCode));
  }

  /** @returns 是否消费了一帧（false = 数据不足或已失败，等下次 push） */
  function tryParseOne(): boolean {
    if (buffer.length < 2) return false;

    const byte0 = buffer[0] as number;
    const byte1 = buffer[1] as number;
    const fin = (byte0 & 0x80) !== 0;
    const rsv = byte0 & 0x70;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLength = byte1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      fail('RSV 位非零（未协商扩展）');
      return false;
    }

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) return false;
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) return false;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME_PAYLOAD)) {
        fail('帧过大', 1009);
        return false;
      }
      payloadLength = Number(big);
      offset += 8;
    }

    if (payloadLength > MAX_FRAME_PAYLOAD) {
      fail('帧过大', 1009);
      return false;
    }

    if (requireMask && !masked) {
      fail('客户端帧必须掩码');
      return false;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (buffer.length < offset + 4) return false;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLength) return false;

    const raw = buffer.subarray(offset, offset + payloadLength);
    const payload = Buffer.allocUnsafe(payloadLength);
    for (let i = 0; i < payloadLength; i += 1) {
      payload[i] = maskKey
        ? (raw[i] as number) ^ (maskKey[i % 4] as number)
        : (raw[i] as number);
    }
    buffer = buffer.subarray(offset + payloadLength);

    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      if (!fin) {
        fail('控制帧不可分片');
        return false;
      }
      if (payloadLength > 125) {
        fail('控制帧 payload 超过 125 字节');
        return false;
      }
      if (opcode === OPCODE.CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason =
          payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (handlers.onClose) handlers.onClose({ code, reason });
      } else if (opcode === OPCODE.PING) {
        if (handlers.onPing) handlers.onPing(payload);
      } else if (opcode === OPCODE.PONG) {
        if (handlers.onPong) handlers.onPong(payload);
      } else {
        fail(`未知控制帧 opcode=${opcode}`);
        return false;
      }
      return true;
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (!fragments) {
        fail('收到 continuation 但无进行中的分片消息');
        return false;
      }
      fragments.chunks.push(payload);
      fragments.size += payload.length;
      if (fragments.size > MAX_MESSAGE_SIZE) {
        fail('消息过大', 1009);
        return false;
      }
      if (fin) {
        const assembled: FrameMessage = {
          opcode: fragments.opcode,
          payload: Buffer.concat(fragments.chunks),
        };
        fragments = null;
        handlers.onMessage(assembled);
      }
      return true;
    }

    if (opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
      fail(`未知数据帧 opcode=${opcode}`);
      return false;
    }
    if (fragments) {
      fail('上一条分片消息未结束');
      return false;
    }

    if (fin) {
      handlers.onMessage({ opcode, payload });
    } else {
      fragments = { opcode, chunks: [payload], size: payload.length };
    }
    return true;
  }

  return {
    push(chunk: Buffer | Uint8Array): void {
      if (failed) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer =
        buffer.length === 0
          ? Buffer.from(incoming)
          : Buffer.concat([buffer, incoming]);
      while (!failed && tryParseOne()) {
        // 循环直到数据不足
      }
    },
    get buffered(): number {
      return buffer.length;
    },
  };
}
