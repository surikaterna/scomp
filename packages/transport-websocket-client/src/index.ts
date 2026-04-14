import { randomUUID } from "node:crypto";
import {
  type ITransport,
  type ScompClientInvokeOptions,
  ScompFrameworkMethods,
} from "@scomp/core";
import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportOperation,
  ScompTransportPrincipal,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
  ScompTransportSecurityPolicy,
} from "@scomp/types";
import {
  toPriorityMeta,
  toPrincipalMeta,
  mergeMeta,
  safeJsonParse,
  isFeedChunkEnvelope,
  checkSecurity,
  type TransportMessage,
} from "@scomp/transport-shared";
import WebSocket, { type RawData } from "ws";

export class SocketDisconnectedError extends Error {
  constructor(message = "WebSocket connection closed.") {
    super(message);
    this.name = "SocketDisconnectedError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface FeedState {
  queue: Array<unknown | Promise<never>>;
  waiters: Array<() => void>;
  closed: boolean;
}

export interface WebSocketClientTransportConfig {
  url: string;
  protocols?: string | Array<string>;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
}

function toText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

export class WebSocketClientTransport implements ITransport {
  private readonly config: WebSocketClientTransportConfig;
  private socket?: WebSocket;
  private openingPromise?: Promise<WebSocket>;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly feeds = new Map<string, FeedState>();
  private readonly pendingFeedChunks = new Map<
    string,
    Array<ScompFeedChunkEnvelope>
  >();

  constructor(config: WebSocketClientTransportConfig) {
    this.config = config;
  }

  async registerRoutes(_router: Record<string, unknown>): Promise<void> {
    // No-op — client-only transport does not host routes.
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.handleDisconnect(
      new SocketDisconnectedError("WebSocket transport closed."),
    );

    if (!socket) {
      return;
    }

    if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      const onClose = () => {
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };

      const onError = () => {
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        socket.close();
      } catch {
        onClose();
      }
    });
  }

  async request(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    return this.sendRpc(route, "request", payload, options);
  }

  async signal(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const socket = await this.getSocket();
    const operation: ScompTransportOperation = "signal";
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = mergeMeta(baseMeta, priorityMeta);
    const { allowed, principal } = await checkSecurity(this.config.security, {
      direction: "outbound",
      transport: "websocket",
      route,
      operation,
      payload,
      meta: effectiveMeta,
    });
    if (!allowed) {
      throw new Error(`signal not authorized for route: ${route}`);
    }
    const envelope: Record<string, unknown> = {
      route,
      op: "signal",
      payload,
      meta: mergeMeta(effectiveMeta, toPrincipalMeta(principal)),
    };

    if (options?.feed) {
      envelope.feed = options.feed;
    }
    if (options?.method) {
      envelope.method = options.method;
    }

    this.sendJson(socket, envelope);
  }

  feed(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<any> {
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const handshake = await self.sendRpc(route, "feed", payload, options);
        const feedHash = String(handshake?.feed ?? "");

        if (!feedHash) {
          throw new Error(
            "Feed start response did not include a feed identifier.",
          );
        }

        const state: FeedState = {
          queue: [],
          waiters: [],
          closed: false,
        };

        self.feeds.set(feedHash, state);
        self.drainPendingFeedChunks(feedHash, state);

        try {
          while (true) {
            if (state.queue.length > 0) {
              const value = state.queue.shift();
              if (value instanceof Promise) {
                await value;
              }

              if (state.closed && value === undefined) {
                return;
              }

              if (value !== undefined) {
                yield value;
              }
            } else if (state.closed) {
              return;
            } else {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
          }
        } finally {
          self.feeds.delete(feedHash);
          const socket = await self.getSocket();
          self.sendJson(socket, {
            route,
            op: "signal",
            feed: feedHash,
            method: ScompFrameworkMethods.UNSUBSCRIBE,
            payload: {},
          });
        }
      },
    };
  }

  private async getSocket(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    if (this.openingPromise) {
      return this.openingPromise;
    }

    this.openingPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.config.url, this.config.protocols);

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };

      const onOpen = () => {
        cleanup();
        this.socket = socket;
        this.attachSocketHandlers(socket);
        this.openingPromise = undefined;
        resolve(socket);
      };

      const onError = (error: Error) => {
        cleanup();
        this.openingPromise = undefined;
        reject(error);
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    return this.openingPromise;
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on("message", (data: RawData) => {
      const parsed = safeJsonParse(toText(data));
      if (!parsed.ok) {
        return;
      }
      const message = parsed.value as TransportMessage;
      this.handleIncoming(message);
    });

    socket.on("close", () => {
      this.handleDisconnect(new SocketDisconnectedError());
    });

    socket.on("error", (error: Error) => {
      this.handleDisconnect(error);
    });
  }

  private handleIncoming(message: TransportMessage): void {
    if (isFeedChunkEnvelope(message)) {
      const feedId = String(message.feed ?? "");
      const feed = this.feeds.get(feedId);
      if (!feed) {
        const pending = this.pendingFeedChunks.get(feedId) ?? [];
        pending.push(message);
        this.pendingFeedChunks.set(feedId, pending);
        return;
      }

      this.enqueueFeedChunk(feed, message);
      return;
    }

    const id = String((message as ScompTransportResponseEnvelope).id ?? "");
    if (!id) {
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(id);

    if (
      "error" in message &&
      typeof message.error === "string" &&
      message.error.length > 0
    ) {
      pending.reject(new Error(message.error));
      return;
    }

    if ("payload" in message) {
      pending.resolve(message.payload);
      return;
    }

    pending.resolve(undefined);
  }

  private handleDisconnect(error: unknown): void {
    this.socket = undefined;
    this.openingPromise = undefined;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.pendingFeedChunks.clear();

    for (const feed of this.feeds.values()) {
      feed.closed = true;
      feed.queue.push(
        Promise.reject(
          error instanceof Error
            ? error
            : new SocketDisconnectedError(String(error)),
        ),
      );
      while (feed.waiters.length > 0) {
        const waiter = feed.waiters.shift();
        waiter?.();
      }
    }
  }

  private async sendRpc(
    route: string,
    op: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    const socket = await this.getSocket();
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = mergeMeta(baseMeta, priorityMeta);
    const { allowed, principal } = await checkSecurity(this.config.security, {
      direction: "outbound",
      transport: "websocket",
      route,
      operation: op,
      payload,
      meta: effectiveMeta,
    });
    if (!allowed) {
      throw new Error(`${op} not authorized for route: ${route}`);
    }
    const id = randomUUID();

    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    const envelope: ScompTransportRequestEnvelope = {
      id,
      route,
      op,
      payload,
      meta: mergeMeta(effectiveMeta, toPrincipalMeta(principal)),
    };

    if (options?.feed) {
      envelope.feed = options.feed;
    }
    if (options?.method) {
      envelope.method = options.method;
    }

    this.sendJson(socket, envelope);

    return response;
  }

  private drainPendingFeedChunks(hash: string, feed: FeedState): void {
    const pending = this.pendingFeedChunks.get(hash);
    if (!pending || pending.length === 0) {
      return;
    }

    this.pendingFeedChunks.delete(hash);
    for (const message of pending) {
      this.enqueueFeedChunk(feed, message);
    }
  }

  private enqueueFeedChunk(
    feed: FeedState,
    message: ScompFeedChunkEnvelope,
  ): void {
    if (message.type === "done") {
      feed.closed = true;
    } else if (message.type === "error") {
      feed.closed = true;
      feed.queue.push(
        Promise.reject(new Error(String(message.message ?? "Feed error"))),
      );
    } else {
      feed.queue.push(message.payload);
    }

    const waiter = feed.waiters.shift();
    waiter?.();
  }

  private sendJson(socket: WebSocket, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    socket.send(serialized);
  }

  private async resolveMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const metaConfig = this.config.meta;
    if (!metaConfig) {
      return undefined;
    }

    if (typeof metaConfig === "function") {
      return metaConfig();
    }

    return metaConfig;
  }
}

export function createWebSocketClientTransport(
  config: WebSocketClientTransportConfig,
): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
