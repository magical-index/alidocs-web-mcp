'use strict';

/**
 * 对外导出的测试辅助（`alidocs-web-mcp/test-helpers`）。
 *
 * 供**下游**做跨实现契约测试：用真实 bridge 进程 + 真实 WS 客户端
 * 验证自己的 transport 实现与本仓协议一致，而不是各自 mock 自说自话。
 *
 * 注意：这些只在测试期使用，不属于运行时 API；接口变更按 semver 处理。
 */

const { connectWs, TestWsClient } = require('./wsClient');
const {
  startTestBridge,
  initializeHost,
  fetchPairingCode,
  connectFakePage,
  waitUntil,
  FakeHost,
} = require('./harness');

module.exports = {
  // WS 客户端（零依赖，net + 帧编解码）
  connectWs,
  TestWsClient,
  // 集成脚手架：真实 bridge + 假 stdio host + 假页面
  startTestBridge,
  initializeHost,
  fetchPairingCode,
  connectFakePage,
  waitUntil,
  FakeHost,
};
