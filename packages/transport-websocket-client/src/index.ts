export { WebSocketClientTransport } from "./transport";
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
export { reconnectWithBackoff, type ReconnectOptions } from "./reconnect";
export {
  createBrowserSocketAdapterFactory,
  type BrowserWebSocketCtor,
  createNodeSocketAdapterFactory,
  NodeSocketAdapter,
  BrowserSocketAdapter,
  type ISocketAdapter,
  type SocketAdapterFactory,
  SOCKET_OPEN,
} from "@scomp/transport-websocket-shared";

import { WebSocketClientTransport } from "./transport";
import type { WebSocketClientTransportConfig } from "./client-types";

export function createWebSocketClientTransport(config: WebSocketClientTransportConfig): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
