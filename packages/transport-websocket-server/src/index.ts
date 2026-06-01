export { StreamClosedError } from "@scompr/transport-websocket-server-runtime";
// Backward-compat aliases (re-exported from bun.ts and node.ts)
export {
  BunWebSocketServerTransport,
  createBunWebSocketServerTransport,
  createWebSocketServerTransport,
  WebSocketServerTransport,
  type WebSocketServerTransportConfig,
} from "./bun";
export {
  createNodeWebSocketServerTransport,
  NodeWebSocketServerTransport,
} from "./node";
export type {
  BunWebSocketServerTransportConfig,
  NodeWebSocketServerTransportConfig,
  WebSocketServerTransportBaseConfig,
} from "./shared";
