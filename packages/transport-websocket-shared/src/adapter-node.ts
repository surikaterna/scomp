import WebSocket, { type RawData } from "ws";
import type { ISocketAdapter, SocketAdapterFactory } from "./socket-adapter";

function toText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * Wraps the Node.js `ws` WebSocket in the platform-agnostic
 * `ISocketAdapter` contract.
 */
export class NodeSocketAdapter implements ISocketAdapter {
  private readonly socket: WebSocket;

  constructor(url: string, protocols?: string | string[]) {
    this.socket = new WebSocket(url, protocols);
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  onOpen(handler: () => void): void {
    this.socket.on("open", handler);
  }

  onMessage(handler: (text: string) => void): void {
    this.socket.on("message", (data: RawData) => {
      handler(toText(data));
    });
  }

  onClose(handler: () => void): void {
    this.socket.on("close", handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.socket.on("error", handler);
  }

  removeAllHandlers(): void {
    this.socket.removeAllListeners();
  }
}

export function createNodeSocketAdapterFactory(): SocketAdapterFactory {
  return (url, protocols) => new NodeSocketAdapter(url, protocols);
}
