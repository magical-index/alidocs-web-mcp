#!/usr/bin/env node

/**
 * alidocs-web-mcp CLI 入口。
 *
 * 作为 MCP host 的 stdio server 使用，例如：
 *   { "command": "npx", "args": ["-y", "alidocs-web-mcp", "--allow-write"] }
 *
 * 日志一律走 stderr（stdout 是 JSON-RPC 协议通道）。
 */

import { parseArgs, type BridgeConfig } from './config.js';
import { createBridge } from './index.js';

const USAGE = `alidocs-web-mcp — DingTalk Doc (alidocs) local MCP bridge

Usage: alidocs-web-mcp [options]

  --port <n>                  Use only this port (default: try 19837/19838/19839)
  --allow-origin <pattern>    Append an Origin allowlist entry (repeatable);
                              '*' matches a single label/port only
  --only-origin <pattern>     Replace the default allowlist entirely (repeatable)
  --allow-write               Allow the page to register write tools (read-only by default)
  --audit-log <path>          Audit log path (default ~/.alidocs-web-mcp/audit.log)
  --no-audit                  Disable the audit log
  --handshake-timeout-ms <n>  WS handshake deadline (default 10000)
  --request-timeout-ms <n>    Timeout for requests forwarded to the page (default 60000)
  -h, --help                  Show this help
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  let config: BridgeConfig;
  try {
    config = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[alidocs-web-mcp] 参数错误: ${message}\n\n${USAGE}`);
    process.exit(2);
    return;
  }

  const bridge = createBridge(config);
  await bridge.start();

  const shutdown = (signal: string): void => {
    process.stderr.write(`[alidocs-web-mcp] 收到 ${signal}，退出\n`);
    bridge
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack : String(error);
  process.stderr.write(`[alidocs-web-mcp] 启动失败: ${stack}\n`);
  process.exit(1);
});
