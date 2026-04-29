/**
 * Runtime-agnostic WebSocket abstraction.
 *
 * Concrete adapters (Node `ws`, browser `WebSocket`) implement this
 * interface so that `WebSocketClientTransport` never touches
 * platform-specific socket APIs directly.
 */

export const SOCKET_OPEN = 1;

export interface ISocketAdapter {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  removeAllHandlers(): void;
}

export type SocketAdapterFactory = (url: string, protocols?: string | string[]) => ISocketAdapter;
