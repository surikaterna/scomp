import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportSecurityPolicy,
} from "@scomp/types";

export class SocketDisconnectedError extends Error {
  constructor(message = "WebSocket connection closed.") {
    super(message);
    this.name = "SocketDisconnectedError";
  }
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface FeedState {
  queue: Array<unknown | Promise<never>>;
  waiters: Array<() => void>;
  closed: boolean;
  terminalError?: Error;
}

export function toDisconnectError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  const message =
    typeof error === "string" && error.length > 0
      ? error
      : "WebSocket connection closed.";
  return new SocketDisconnectedError(message);
}

export type BrowserSocket = Pick<
  WebSocket,
  "send" | "close" | "addEventListener" | "removeEventListener" | "readyState"
>;

export type BrowserWebSocketCtor = new (
  url: string,
  protocols?: string | Array<string>,
) => BrowserSocket;

export interface WebSocketBrowserTransportConfig {
  url: string;
  protocols?: string | Array<string>;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
  webSocketCtor?: BrowserWebSocketCtor;
}

export async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }

  return String(data ?? "");
}

export function enqueueFeedChunk(
  feed: FeedState,
  message: ScompFeedChunkEnvelope,
): void {
  if (message.type === "done") {
    feed.closed = true;
    feed.terminalError = undefined;
  } else if (message.type === "error") {
    feed.closed = true;
    const error = new Error(String(message.message ?? "Feed error"));
    feed.terminalError = error;
    feed.queue.push(Promise.reject(error));
  } else {
    feed.queue.push(message.payload);
  }

  const waiter = feed.waiters.shift();
  waiter?.();
}

export function drainPendingFeedChunks(
  hash: string,
  feed: FeedState,
  pendingFeedChunks: Map<string, Array<ScompFeedChunkEnvelope>>,
): void {
  const pending = pendingFeedChunks.get(hash);
  if (!pending || pending.length === 0) {
    return;
  }

  pendingFeedChunks.delete(hash);
  for (const message of pending) {
    enqueueFeedChunk(feed, message);
  }
}

export function handleDisconnect(
  pendingRequests: Map<string, PendingRequest>,
  feeds: Map<string, FeedState>,
  pendingFeedChunks: Map<string, Array<ScompFeedChunkEnvelope>>,
  error: unknown,
): { disconnectError: Error } {
  const disconnectError = toDisconnectError(error);

  for (const pending of pendingRequests.values()) {
    pending.reject(disconnectError);
  }
  pendingRequests.clear();

  pendingFeedChunks.clear();

  for (const feed of feeds.values()) {
    feed.closed = true;
    feed.terminalError = disconnectError;
    feed.queue.push(Promise.reject(disconnectError));
    while (feed.waiters.length > 0) {
      const waiter = feed.waiters.shift();
      waiter?.();
    }
  }

  return { disconnectError };
}
