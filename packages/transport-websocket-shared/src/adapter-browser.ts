import type { ISocketAdapter, SocketAdapterFactory } from "./socket-adapter";

export type BrowserWebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data ?? "");
}

/**
 * Wraps the browser-native `WebSocket` in the platform-agnostic
 * `ISocketAdapter` contract.
 *
 * `onMessage` converts Blob / ArrayBuffer data to text before
 * invoking the handler so the transport layer sees only strings.
 */
export class BrowserSocketAdapter implements ISocketAdapter {
  private readonly socket: WebSocket;
  private readonly listeners: Array<{
    type: string;
    handler: EventListenerOrEventListenerObject;
  }> = [];

  constructor(url: string, protocols: string | string[] | undefined, WebSocketCtor: BrowserWebSocketCtor) {
    this.socket = new WebSocketCtor(url, protocols);
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
    this.track("open", handler as EventListener);
  }

  onMessage(handler: (text: string) => void): void {
    const listener = (event: MessageEvent) => {
      void toText(event.data).then(handler);
    };
    this.track("message", listener as EventListener);
  }

  onClose(handler: () => void): void {
    this.track("close", handler as EventListener);
  }

  onError(handler: (error: unknown) => void): void {
    this.track("error", handler as EventListener);
  }

  removeAllHandlers(): void {
    for (const { type, handler } of this.listeners) {
      this.socket.removeEventListener(type, handler);
    }
    this.listeners.length = 0;
  }

  private track(type: string, handler: EventListenerOrEventListenerObject): void {
    this.socket.addEventListener(type, handler);
    this.listeners.push({ type, handler });
  }
}

export function createBrowserSocketAdapterFactory(WebSocketCtor?: BrowserWebSocketCtor): SocketAdapterFactory {
  const Ctor = WebSocketCtor ?? resolveGlobalWebSocket();
  return (url, protocols) => new BrowserSocketAdapter(url, protocols, Ctor);
}

function resolveGlobalWebSocket(): BrowserWebSocketCtor {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
      "No WebSocket constructor found. " + "Provide a WebSocket constructor to createBrowserSocketAdapterFactory().",
    );
  }
  return globalThis.WebSocket as unknown as BrowserWebSocketCtor;
}
