#!/usr/bin/env node
'use strict';

/**
 * alidocs-web-mcp 启动入口。
 *
 * 作为 MCP host 的 stdio server 使用，例如：
 *   { "command": "node", "args": ["<repo>/bin/alidocs-web-mcp.js"] }
 *
 * 日志一律走 stderr（stdout 是 JSON-RPC 协议通道）。
 */

const { parseArgs } = require('../src/config');
const { createBridge } = require('../src/index');

const USAGE = `alidocs-web-mcp — 钉钉文档 Web MCP 本地桥

用法: alidocs-web-mcp [options]

  --port <n>                  指定监听端口（只用该端口）；默认依次尝试候选集 19837/19838/19839
  --allow-origin <pattern>    追加 Origin 白名单条目（可重复），* 只匹配单个 label/端口
  --only-origin <pattern>     用给定条目完全替换默认白名单（可重复）
  --allow-write               允许页面注册写工具（默认只读）
  --audit-log <path>          审计日志路径，默认 ~/.alidocs-web-mcp/audit.log
  --no-audit                  关闭审计日志
  --handshake-timeout-ms <n>  WS 握手等待时限，默认 10000
  --request-timeout-ms <n>    转发给页面的请求超时，默认 60000
  -h, --help                  显示本帮助
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  let config;
  try {
    config = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[alidocs-web-mcp] 参数错误: ${error.message}\n\n${USAGE}`);
    process.exit(2);
    return;
  }

  const bridge = createBridge(config);
  await bridge.start();

  const shutdown = (signal) => {
    process.stderr.write(`[alidocs-web-mcp] 收到 ${signal}，退出\n`);
    bridge
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(`[alidocs-web-mcp] 启动失败: ${error && error.stack}\n`);
  process.exit(1);
});
