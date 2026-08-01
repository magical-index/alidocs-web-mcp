'use strict';

/**
 * stdio 上的 JSON-RPC 通道（MCP stdio transport 约定：换行分隔的 JSON，消息内不含裸换行）。
 *
 * 注意：stdout 是协议通道，任何日志都必须走 stderr，否则会污染消息流。
 */

class StdioChannel {
  /**
   * @param {{
   *   input?: import('stream').Readable,
   *   output?: import('stream').Writable,
   *   onMessage: (message: object) => void,
   *   onParseError?: (line: string, error: Error) => void,
   *   onClose?: () => void,
   * }} options
   */
  constructor(options) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.onMessage = options.onMessage;
    this.onParseError = options.onParseError || (() => {});
    this.onClose = options.onClose || (() => {});
    this.buffer = '';

    this.input.setEncoding('utf8');
    this.input.on('data', (chunk) => this.push(chunk));
    this.input.on('end', () => this.onClose());
    this.input.on('close', () => this.onClose());
  }

  push(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line));
        } catch (error) {
          this.onParseError(line, error);
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  /** 发送一条 JSON-RPC 消息 */
  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

module.exports = { StdioChannel };
