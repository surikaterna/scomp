import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportSecurityPolicy,
} from "@scomp/types";
import type { ISocketAdapter, SocketAdapterFactory } from "@scomp/transport-websocket-shared";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SocketDisconnectedError extends Error {
  constructor(message = "WebSocket connection closed.") {
    super(message);
    this.name = "SocketDisconnectedError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(route: string, timeoutMs: number) {
    super(
      `WebSocket request timed out after ${timeoutMs}ms for route: ${route}`,
    );
    this.name = "RequestTimeoutError";
  }
}

export class InFlightLimitError extends Error {
  constructor(limit: number) {
    super(`WebSocket in-flight request limit reached: ${limit}`);
    this.name = "InFlightLimitError";
  }
}

export class FeedBackpressureError extends Error {
  constructor(feedId: string, limit: number) {
    super(`WebSocket feed buffer exceeded ${limit} chunks for feed: ${feedId}`);
    this.name = "FeedBackpressureError";
  }
}

export class ConnectionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`WebSocket connection timed out after ${timeoutMs}ms`);
    this.name = "ConnectionTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type WebSocketTransportEvent =
  | { type: "connection_opened" }
  | { type: "connection_closed"; reason?: string }
  | { type: "connection_reconnect"; attempt: number }
  | { type: "connection_reconnect_failed"; attempts: number; error: string }
  | { type: "request_timeout"; route: string; requestId: string; timeoutMs: number }
  | { type: "in_flight_limit"; route: string; limit: number }
  | { type: "feed_backpressure"; feedId: string; limit: number };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebSocketReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WebSocketClientTransportConfig {
  url: string;
  protocols?: string | string[];
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
  socketAdapter: SocketAdapterFactory;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxInFlightRequests?: number;
  feedBufferHighWaterMark?: number;
  reconnect?: WebSocketReconnectConfig;
  onEvent?: (event: WebSocketTransportEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

export function toDisconnectError(error: unknown): Error {
  if (error instanceof Error) return error;

  const message =
    typeof error === "string" && error.length > 0
      ? error
      : "WebSocket connection closed.";
  return new SocketDisconnectedError(message);
}

export function enqueueFeedChunk(
  feed: FeedState,
  message: ScompFeedChunkEnvelope,
  bufferLimit = 1_024,
): void {
  if (message.type === "next" && feed.queue.length >= bufferLimit) {
    feed.closed = true;
    const error = new FeedBackpressureError(
      String((message as unknown as Record<string, unknown>).feed ?? "unknown"),
      bufferLimit,
    );
    feed.terminalError = error;
    const rejection = Promise.reject(error);
    rejection.catch(noop);
    feed.queue.push(rejection);
    const waiter = feed.waiters.shift();
    waiter?.();
    return;
  }

  if (message.type === "done") {
    feed.closed = true;
    feed.terminalError = undefined;
  } else if (message.type === "error") {
    feed.closed = true;
    const error = new Error(String(message.message ?? "Feed error"));
    feed.terminalError = error;
    const rejection = Promise.reject(error);
    rejection.catch(noop);
    feed.queue.push(rejection);
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
  if (!pending || pending.length === 0) return;

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
    const rejection = Promise.reject(disconnectError);
    // Prevent Node.js unhandled-rejection detection; the error will
    // be surfaced via terminalError when the feed loop resumes.
    rejection.catch(noop);
    feed.queue.push(rejection);
    while (feed.waiters.length > 0) {
      const waiter = feed.waiters.shift();
      waiter?.();
    }
  }

  return { disconnectError };
}

/**
 * Opens a socket connection with a configurable timeout.
 * Returns a promise that resolves when the socket opens or rejects on
 * error / timeout. The `onReady` callback is invoked before resolving so
 * the caller can attach runtime handlers (message, close, error).
 */
export function createSocketConnection(
  config: WebSocketClientTransportConfig,
  onReady: (adapter: ISocketAdapter) => void,
): Promise<ISocketAdapter> {
  const timeoutMs = config.connectionTimeoutMs ?? 10_000;
  return new Promise<ISocketAdapter>((resolve, reject) => {
    const adapter = config.socketAdapter(config.url, config.protocols);
    const timer = setTimeout(() => {
      adapter.removeAllHandlers();
      try { adapter.close(); } catch { /* ignore */ }
      reject(new ConnectionTimeoutError(timeoutMs));
    }, timeoutMs);

    adapter.onOpen(() => {
      clearTimeout(timer);
      adapter.removeAllHandlers();
      onReady(adapter);
      resolve(adapter);
    });
    adapter.onError((error: unknown) => {
      clearTimeout(timer);
      adapter.removeAllHandlers();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
