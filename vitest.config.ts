import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // bridge 用固定端口候选集（19837/38/39），并行会互相抢端口 → 必须串行。
    // Vitest 4：fileParallelism:false 会把 maxWorkers 压到 1，无需再配 poolOptions。
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 测试辅助本身是给下游用的公开 API，不计入覆盖率目标；cli 由产物 smoke 覆盖
      exclude: ['src/testing/**', 'src/cli.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
