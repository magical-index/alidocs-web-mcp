'use strict';

/**
 * bridge 配置与 CLI 参数解析。
 *
 * 安全默认值（详见 docs/security.md）：
 * - host 固定 127.0.0.1（S1，不可通过参数改成 0.0.0.0）
 * - Origin 白名单默认只放行**官方文档环境（生产/预发）+ 本地开发域**，逐条枚举不通配（S2）
 * - 固定端口候选集（页面发现所需）；被占用则顺延，全占用报错（S4）
 * - 默认只读（S5），写能力需显式 --allow-write
 */

const os = require('os');
const path = require('path');

/** 仅 bind 环回地址（S1）。故意不做成可配置项 */
const BIND_HOST = '127.0.0.1';

/**
 * 固定端口候选集（S4 / 耦合一）：页面 connector 依次探测这些端口发现 bridge。
 * bridge 启动时依次尝试 bind，用第一个空闲端口。全部被占用则报错。
 */
const DEFAULT_PORT_CANDIDATES = [19837, 19838, 19839];

/**
 * 默认 Origin 白名单（S2），支持 `*` 通配单个 label / 端口。
 *
 * 只列举**已知的官方文档环境**与本地开发域，逐条显式枚举：
 * 故意**不用 `https://*.dingtalk.com` 这类宽泛通配**——否则任意子域页面（含第三方
 * 可控内容的子域）都能连本地桥。自建域/其他环境用 `--allow-origin` 追加，例如：
 *   --allow-origin 'https://staging.example.com'
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://alidocs.dingtalk.com',
  'https://pre-alidocs.dingtalk.com',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

const DEFAULTS = {
  /** 显式 --port 时只用该端口；否则用 DEFAULT_PORT_CANDIDATES */
  port: null,
  portCandidates: DEFAULT_PORT_CANDIDATES,
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
  allowWrite: false,
  /** WS 连接建立后等待 auth 帧的时限（S10 握手超时） */
  handshakeTimeoutMs: 10 * 1000,
  /** 转发给页面的请求超时（避免 agent 空等，S7） */
  requestTimeoutMs: 60 * 1000,
  /** 审计日志路径（S9），null = 关闭 */
  auditLogPath: path.join(os.homedir(), '.alidocs-web-mcp', 'audit.log'),
};

/**
 * Origin 通配匹配：`*` 只匹配单个 host label 或端口，不跨 `.` 与 `:`。
 *
 * 例：`https://*.example.com` 命中 `https://a.example.com`，
 * 不命中 `https://evil.com/?x=.dingtalk.com`（Origin 无 path，故仅需防 label 越界）。
 *
 * @param {string} origin
 * @param {string} pattern
 * @returns {boolean}
 */
function matchOrigin(origin, pattern) {
  if (typeof origin !== 'string' || !origin) return false;
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;

  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.:/]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

/**
 * 判断 Origin 是否在白名单内（S2）。
 *
 * @param {string} origin
 * @param {string[]} allowedOrigins
 * @returns {boolean}
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return false;
  return allowedOrigins.some((pattern) => matchOrigin(origin, pattern));
}

/**
 * 解析 CLI 参数。
 *
 * ```
 * alidocs-web-mcp [--port <n>] [--allow-origin <pattern>]... [--allow-write]
 *               [--audit-log <path>|--no-audit] [--token-ttl-ms <n>]
 *               [--handshake-timeout-ms <n>] [--request-timeout-ms <n>]
 * ```
 *
 * @param {string[]} argv
 * @returns {object} 归一化配置
 */
function parseArgs(argv) {
  const config = {
    ...DEFAULTS,
    portCandidates: [...DEFAULT_PORT_CANDIDATES],
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS],
    host: BIND_HOST,
  };
  const extraOrigins = [];
  let originsReplaced = false;
  let explicitPort = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少值`);
      return value;
    };
    switch (arg) {
      case '--port':
        explicitPort = Number(next());
        break;
      case '--allow-origin':
        extraOrigins.push(next());
        break;
      case '--only-origin':
        // 收紧模式：完全替换默认白名单
        if (!originsReplaced) {
          originsReplaced = true;
          config.allowedOrigins = [];
        }
        config.allowedOrigins.push(next());
        break;
      case '--allow-write':
        config.allowWrite = true;
        break;
      case '--audit-log':
        config.auditLogPath = next();
        break;
      case '--no-audit':
        config.auditLogPath = null;
        break;
      case '--handshake-timeout-ms':
        config.handshakeTimeoutMs = Number(next());
        break;
      case '--request-timeout-ms':
        config.requestTimeoutMs = Number(next());
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  config.allowedOrigins = config.allowedOrigins.concat(extraOrigins);
  // 显式 --port：只用该端口（候选集收敛为单元素）；否则用默认候选集
  if (explicitPort !== null) {
    if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
      throw new Error(`--port 非法: ${explicitPort}`);
    }
    config.port = explicitPort;
    config.portCandidates = [explicitPort];
  }
  return config;
}

module.exports = {
  BIND_HOST,
  DEFAULTS,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_PORT_CANDIDATES,
  matchOrigin,
  isOriginAllowed,
  parseArgs,
};
