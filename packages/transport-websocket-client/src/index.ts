export {
  BrowserSocketAdapter,
  type BrowserWebSocketCtor,
  createBrowserSocketAdapterFactory,
  createNodeSocketAdapterFactory,
  type ISocketAdapter,
  NodeSocketAdapter,
  SOCKET_OPEN,
  type SocketAdapterFactory,
} from "@scompr/transport-websocket-shared";
export {
  ConnectionTimeoutError,
  FeedBackpressureError,
  type FeedState,
  InFlightLimitError,
  RequestTimeoutError,
  SocketDisconnectedError,
  type WebSocketClientTransportConfig,
  type WebSocketReconnectConfig,
  type WebSocketTransportEvent,
} from "./client-types";
export { type ReconnectOptions, reconnectWithBackoff } from "./reconnect";
export { WebSocketClientTransport } from "./transport";

import type { WebSocketClientTransportConfig } from "./client-types";
import { WebSocketClientTransport } from "./transport";

export function createWebSocketClientTransport(config: WebSocketClientTransportConfig): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
