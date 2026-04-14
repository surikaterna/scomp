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
import { type ISocketAdapter, SOCKET_OPEN } from "./socket-adapter";
import {
  SocketDisconnectedError,
  RequestTimeoutError,
  InFlightLimitError,
  enqueueFeedChunk,
  drainPendingFeedChunks,
  handleDisconnect,
  createSocketConnection,
  type WebSocketClientTransportConfig,
  type WebSocketTransportEvent,
  type PendingRequest,
  type FeedState,
} from "./client-types";
import { runReconnectLoop } from "./reconnect";

export class WebSocketClientTransport implements ITransport {
  private readonly config: WebSocketClientTransportConfig;
  private socket?: ISocketAdapter;
  private openingPromise?: Promise<ISocketAdapter>;
  private lastDisconnectError?: Error;
  private reconnectAbort?: AbortController;
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
    this.reconnectAbort?.abort();
    const socket = this.socket;
    this.onDisconnect(
      new SocketDisconnectedError("WebSocket transport closed."),
    );

    if (!socket) return;
    if (socket.readyState >= 2) return;
    try {
      socket.close();
    } catch {
      /* no-op */
    }
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
    const meta = await this.composeOutboundMeta(options, undefined);
    const { allowed, principal } = await checkSecurity(this.config.security, {
      direction: "outbound",
      transport: "websocket",
      route,
      operation: "signal",
      payload,
      meta,
    });
    if (!allowed) throw new Error(`signal not authorized for route: ${route}`);

    const envelope: Record<string, unknown> = {
      route,
      op: "signal",
      payload,
      meta: mergeMeta(meta, toPrincipalMeta(principal)),
    };
    if (options?.feed) envelope.feed = options.feed;
    if (options?.method) envelope.method = options.method;

    socket.send(JSON.stringify(envelope));
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
          terminalError: undefined,
        };
        self.feeds.set(feedHash, state);

        if (!self.socket || !self.isOpen(self.socket)) {
          state.closed = true;
          const err =
            self.lastDisconnectError ?? new SocketDisconnectedError();
          const rejection = Promise.reject(err);
          rejection.catch(() => {});
          state.queue.push(rejection);
        }

        drainPendingFeedChunks(feedHash, state, self.pendingFeedChunks);

        try {
          while (true) {
            if (state.queue.length > 0) {
              const value = state.queue.shift();
              if (value instanceof Promise) await value;
              if (state.closed && value === undefined) {
                if (state.terminalError ?? self.lastDisconnectError) {
                  throw state.terminalError ?? self.lastDisconnectError;
                }
                return;
              }
              if (value !== undefined) yield value;
            } else if (state.closed) {
              if (state.terminalError ?? self.lastDisconnectError) {
                throw state.terminalError ?? self.lastDisconnectError;
              }
              return;
            } else {
              await new Promise<void>((r) => state.waiters.push(r));
            }
          }
        } finally {
          self.feeds.delete(feedHash);
          self.pendingFeedChunks.delete(feedHash);
          const activeSocket = self.socket;
          if (!activeSocket || !self.isOpen(activeSocket)) return;
          try {
            activeSocket.send(
              JSON.stringify({
                route,
                op: "signal",
                feed: feedHash,
                method: ScompFrameworkMethods.UNSUBSCRIBE,
                payload: {},
              }),
            );
          } catch (err) {
            if (!(err instanceof SocketDisconnectedError)) throw err;
          }
        }
      },
    };
  }

  // Private — socket lifecycle

  private isOpen(s: ISocketAdapter): boolean { return s.readyState === SOCKET_OPEN; }

  private async getSocket(): Promise<ISocketAdapter> {
    if (this.socket && this.isOpen(this.socket)) return this.socket;
    if (this.openingPromise) return this.openingPromise;

    this.openingPromise = this.connectSocket().then((adapter) => {
      this.socket = adapter;
      this.lastDisconnectError = undefined;
      this.openingPromise = undefined;
      this.emitEvent({ type: "connection_opened" });
      return adapter;
    });

    this.openingPromise.catch(() => {
      this.openingPromise = undefined;
    });

    return this.openingPromise;
  }

  private connectSocket(): Promise<ISocketAdapter> {
    return createSocketConnection(this.config, (adapter) => {
      this.attachSocketHandlers(adapter);
    });
  }

  private attachSocketHandlers(adapter: ISocketAdapter): void {
    adapter.onMessage((text: string) => {
      const parsed = safeJsonParse(text);
      if (!parsed.ok) return;
      this.handleIncoming(parsed.value as TransportMessage);
    });
    adapter.onClose(() =>
      this.onDisconnect(new SocketDisconnectedError()),
    );
    adapter.onError((error) => this.onDisconnect(error));
  }

  // Private — message handling

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
      enqueueFeedChunk(
        feed,
        message,
        this.config.feedBufferHighWaterMark ?? 1_024,
      );
      return;
    }

    const id = String((message as ScompTransportResponseEnvelope).id ?? "");
    if (!id) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
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

  private onDisconnect(error: unknown): void {
    this.socket = undefined;
    const { disconnectError } = handleDisconnect(
      this.pendingRequests,
      this.feeds,
      this.pendingFeedChunks,
      error,
    );
    this.lastDisconnectError = disconnectError;
    this.emitEvent({
      type: "connection_closed",
      reason: disconnectError.message,
    });
    if (
      this.config.reconnect?.enabled &&
      !this.reconnectAbort?.signal.aborted &&
      !this.openingPromise
    ) {
      this.reconnectAbort = new AbortController();
      const loop = runReconnectLoop({
        cfg: this.config.reconnect,
        connect: () => this.connectSocket(),
        onConnected: (s) => {
          this.socket = s;
          this.emitEvent({ type: "connection_opened" });
        },
        emitEvent: (e) => this.emitEvent(e),
        signal: this.reconnectAbort.signal,
      });
      this.openingPromise = loop.then((s) => {
        if (!s) throw new Error("Reconnect failed");
        return s;
      });
      void this.openingPromise.catch(() => {}).finally(() => {
        this.openingPromise = undefined;
      });
    }
  }

  private emitEvent(event: WebSocketTransportEvent): void {
    this.config.onEvent?.(event);
  }

  // Private — RPC helpers

  private async sendRpc(
    route: string,
    op: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    const maxInFlight = this.config.maxInFlightRequests ?? 10_000;
    if (this.pendingRequests.size >= maxInFlight) {
      this.emitEvent({ type: "in_flight_limit", route, limit: maxInFlight });
      throw new InFlightLimitError(maxInFlight);
    }

    const socket = await this.getSocket();
    const { allowed, principal } = await checkSecurity(this.config.security, {
      direction: "outbound",
      transport: "websocket",
      route,
      operation: op,
      payload,
      meta: await this.composeOutboundMeta(options, undefined),
    });
    if (!allowed) throw new Error(`${op} not authorized for route: ${route}`);

    const id = randomUUID();
    const replyPromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    const outboundMeta = await this.composeOutboundMeta(options, principal);
    const envelope: ScompTransportRequestEnvelope = {
      id,
      route,
      op,
      payload,
      meta: outboundMeta,
    };
    if (options?.feed) envelope.feed = options.feed;
    if (options?.method) envelope.method = options.method;

    socket.send(JSON.stringify(envelope));

    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        this.emitEvent({
          type: "request_timeout",
          route,
          requestId: id,
          timeoutMs,
        });
        reject(new RequestTimeoutError(route, timeoutMs));
      }, timeoutMs);
      // Clear timer when reply arrives or disconnect rejects.
      // The .catch prevents an unhandled rejection from the finally chain.
      void replyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });

    return Promise.race([replyPromise, timeoutPromise]);
  }

  /** Deterministic outbound meta: config.meta → options.meta → priority → principal. */
  private async composeOutboundMeta(
    options: ScompClientInvokeOptions | undefined,
    principal: ScompTransportPrincipal | undefined,
  ): Promise<ScompTransportMessageMeta | undefined> {
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = mergeMeta(baseMeta, priorityMeta);
    return mergeMeta(effectiveMeta, toPrincipalMeta(principal));
  }

  private async resolveMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const metaConfig = this.config.meta;
    if (!metaConfig) return undefined;
    if (typeof metaConfig === "function") return metaConfig();
    return metaConfig;
  }
}
