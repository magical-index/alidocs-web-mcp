/**
 * 产物 smoke：验证「真正发布出去的东西」能跑。
 *
 * 其余用例直接测 `src/`（类型受检、秒级反馈）；这一条专门守编译产物特有的风险：
 * shebang 丢失、`exports` 指向不存在的文件、`vectors.json` 没拷进去、
 * 以及只在 ESM 产物形态下才炸的写法（如 `__dirname`）。
 *
 * `dist/` 缺失或比 `src/` 旧时会自动 build——避免测到旧产物（本仓老坑）。
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { beforeAll, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const pkg = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
) as typeof import('../package.json');

/** 目录树里最新的修改时间（判断产物是否已过期） */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtimeMs(full)
      : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

beforeAll(() => {
  const distMtime = existsSync(DIST_CLI) ? statSync(DIST_CLI).mtimeMs : 0;
  if (distMtime < newestMtimeMs(join(ROOT, 'src'))) {
    // 静默重建：只改 src 就跑测试时，不该测到上一次的产物
    execFileSync(NPM, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
}, 120_000);

it('dist/cli.js 带 shebang（否则 npx 无法执行）', () => {
  const firstLine = readFileSync(DIST_CLI, 'utf8').split('\n')[0] ?? '';
  expect(firstLine.startsWith('#!')).toBe(true);
  expect(firstLine).toContain('node');
});

it('package.json 里 bin / exports 指到的文件全部真实存在', () => {
  const targets = [pkg.bin['alidocs-web-mcp']];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (subpath === './package.json') continue;
    if (typeof entry === 'string') targets.push(entry);
    else targets.push(entry.types, entry.default);
  }

  const missing = targets.filter((target) => !existsSync(join(ROOT, target)));
  expect(missing).toEqual([]);
});

it('vectors.json 已拷进产物且与源逐字一致（跨实现一致性向量）', () => {
  const fromSrc = readFileSync(
    join(ROOT, 'src', 'protocol', 'vectors.json'),
    'utf8',
  );
  const fromDist = readFileSync(
    join(ROOT, 'dist', 'protocol', 'vectors.json'),
    'utf8',
  );
  expect(fromDist).toBe(fromSrc);
});

it('零运行时依赖（A1：npx 即用，不引入供应链风险）', () => {
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});

it('ESM 产物可被 CJS 调用方 require（Node ≥22.12 的 require(esm)）', () => {
  const require = createRequire(import.meta.url);
  const mod = require('../dist/index.js') as { VERSION: string };
  expect(mod.VERSION).toBe(pkg.version);
});

it('真实 CLI 进程能完成 initialize，且自报版本与 package.json 一致', async () => {
  const child = spawn(process.execPath, [DIST_CLI, '--port', '19871'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  const firstMessage = new Promise<{
    result: { serverInfo: { name: string; version: string } };
  }>((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      resolve(JSON.parse(buffer.slice(0, index)));
    });
    child.on('exit', (code) =>
      reject(new Error(`CLI 提前退出(code=${code}): ${stderr.join('')}`)),
    );
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'artifact-smoke', version: '0.0.0' },
      },
    })}\n`,
  );

  try {
    const { result } = await firstMessage;
    expect(result.serverInfo.name).toBe('alidocs-web-mcp');
    // 版本号靠 import.meta.url 读 package.json；ESM 下写成 __dirname 会静默退化成 0.0.0
    expect(result.serverInfo.version).toBe(pkg.version);
  } finally {
    child.kill('SIGTERM');
  }
});

it('CLI --help 走 stderr 并以 0 退出（stdout 是协议通道，不得污染）', async () => {
  const child = spawn(process.execPath, [DIST_CLI, '--help'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const code = await new Promise<number | null>((resolve) =>
    child.on('exit', resolve),
  );
  expect(code).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toContain('--allow-write');
});
