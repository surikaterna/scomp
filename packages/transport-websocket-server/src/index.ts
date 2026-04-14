export {
  BunWebSocketServerTransport,
  createBunWebSocketServerTransport,
} from "./bun";

export {
  NodeWebSocketServerTransport,
  createNodeWebSocketServerTransport,
} from "./node";

export type {
  BunWebSocketServerTransportConfig,
  NodeWebSocketServerTransportConfig,
  WebSocketServerTransportBaseConfig,
} from "./shared";

export { StreamClosedError } from "@scomp/transport-websocket-server-runtime";

// Backward-compat aliases (re-exported from bun.ts and node.ts)
export {
  WebSocketServerTransport,
  type WebSocketServerTransportConfig,
  createWebSocketServerTransport,
} from "./bun";
