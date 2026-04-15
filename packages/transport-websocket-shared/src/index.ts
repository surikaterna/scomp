export { SOCKET_OPEN, type ISocketAdapter, type SocketAdapterFactory } from "./socket-adapter";
export { NodeSocketAdapter, createNodeSocketAdapterFactory } from "./adapter-node";
export {
  BrowserSocketAdapter,
  createBrowserSocketAdapterFactory,
  type BrowserWebSocketCtor,
} from "./adapter-browser";
