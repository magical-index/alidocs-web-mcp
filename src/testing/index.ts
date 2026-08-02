/**
 * 测试辅助的公开入口（`alidocs-web-mcp/testing`）。
 *
 * 供**下游**（如页面侧实现）用真实 bridge 进程 + 真实 WS 客户端做跨实现契约测试，
 * 而不是两端各自 mock —— 各自 mock 会形成"契约幻觉"。
 *
 * 这些只在测试期使用，不属于运行时 API；接口变更按 semver 处理。
 */

export { connectWs, TestWsClient } from './wsClient.js';
export type {
  ConnectWsOptions,
  WsCloseInfo,
  WsUpgradeError,
} from './wsClient.js';

export {
  startTestBridge,
  initializeHost,
  fetchPairingCode,
  connectFakePage,
  waitUntil,
  FakeHost,
  // 断言辅助：把弱类型的 JSON-RPC 响应收窄成可断言的形状，失败即抛
  resultOf,
  errorOf,
  structuredOf,
  readyOf,
  handshakeErrorOf,
} from './harness.js';
export type {
  TestBridgeHandle,
  FakePage,
  ConnectFakePageOptions,
  PageToolDefinition,
  PageHandshakeResult,
  HostMessage,
  InitializeResult,
  ToolsListResult,
  ToolCallResult,
} from './harness.js';
