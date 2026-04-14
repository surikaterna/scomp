export { WebSocketClientTransport } from "./transport";
export {
  createBrowserSocketAdapterFactory,
  type BrowserWebSocketCtor,
} from "./adapter-browser";
export { createNodeSocketAdapterFactory } from "./adapter-node";
export {
  SocketDisconnectedError,
  RequestTimeoutError,
  InFlightLimitError,
  FeedBackpressureError,
  ConnectionTimeoutError,
  type WebSocketClientTransportConfig,
  type WebSocketReconnectConfig,
  type WebSocketTransportEvent,
  type FeedState,
} from "./client-types";
export {
  type ISocketAdapter,
  type SocketAdapterFactory,
  SOCKET_OPEN,
} from "./socket-adapter";
export { reconnectWithBackoff, type ReconnectOptions } from "./reconnect";

import { WebSocketClientTransport } from "./transport";
import type { WebSocketClientTransportConfig } from "./client-types";

export function createWebSocketClientTransport(
  config: WebSocketClientTransportConfig,
): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
