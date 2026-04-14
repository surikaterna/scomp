import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportSecurityPolicy,
} from "@scomp/types";
import type { SocketAdapterFactory } from "./socket-adapter";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SocketDisconnectedError extends Error {
  constructor(message = "WebSocket connection closed.") {
    super(message);
    this.name = "SocketDisconnectedError";
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
// Config
// ---------------------------------------------------------------------------

export interface WebSocketClientTransportConfig {
  url: string;
  protocols?: string | string[];
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
  socketAdapter: SocketAdapterFactory;
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
): void {
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
