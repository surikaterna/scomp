export { WebSocketClientTransport } from "./transport";
export {
  createBrowserSocketAdapterFactory,
  type BrowserWebSocketCtor,
} from "./adapter-browser";
export { createNodeSocketAdapterFactory } from "./adapter-node";
export {
  SocketDisconnectedError,
  type WebSocketClientTransportConfig,
  type FeedState,
} from "./client-types";
export {
  type ISocketAdapter,
  type SocketAdapterFactory,
  SOCKET_OPEN,
} from "./socket-adapter";

import { WebSocketClientTransport } from "./transport";
import type { WebSocketClientTransportConfig } from "./client-types";

export function createWebSocketClientTransport(
  config: WebSocketClientTransportConfig,
): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
