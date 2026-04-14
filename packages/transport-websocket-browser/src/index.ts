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
import {
  SocketDisconnectedError,
  toText,
  enqueueFeedChunk,
  drainPendingFeedChunks,
  handleDisconnect,
  type BrowserSocket,
  type BrowserWebSocketCtor,
  type FeedState,
  type PendingRequest,
  type WebSocketBrowserTransportConfig,
} from "./types";

export class WebSocketBrowserTransport implements ITransport {
  private readonly config: WebSocketBrowserTransportConfig;
  private socket?: BrowserSocket;
  private openingPromise?: Promise<BrowserSocket>;
  private lastDisconnectError?: Error;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly feeds = new Map<string, FeedState>();
  private readonly pendingFeedChunks = new Map<
    string,
    Array<ScompFeedChunkEnvelope>
  >();

  constructor(config: WebSocketBrowserTransportConfig) {
    this.config = config;
  }

  async registerRoutes(_router: Record<string, unknown>): Promise<void> {
    // No-op — client-only transport does not host routes.
  }

  async close(): Promise<void> {
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
    if (!allowed) throw new Error(`signal not authorized for route: ${route}`);

    const envelope: Record<string, unknown> = {
      route,
      op: "signal",
      payload,
      meta: mergeMeta(effectiveMeta, toPrincipalMeta(principal)),
    };
    if (options?.feed) envelope.feed = options.feed;
    if (options?.method) envelope.method = options.method;

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
        if (!feedHash)
          throw new Error(
            "Feed start response did not include a feed identifier.",
          );

        const state: FeedState = {
          queue: [],
          waiters: [],
          closed: false,
          terminalError: undefined,
        };
        self.feeds.set(feedHash, state);
        if (!self.socket || !self.isOpen(self.socket)) {
          state.closed = true;
          state.queue.push(
            Promise.reject(
              self.lastDisconnectError ?? new SocketDisconnectedError(),
            ),
          );
        }

        drainPendingFeedChunks(feedHash, state, self.pendingFeedChunks);

        try {
          while (true) {
            if (state.queue.length > 0) {
              const value = state.queue.shift();
              if (value instanceof Promise) await value;
              if (state.closed && value === undefined) {
                if (state.terminalError ?? self.lastDisconnectError)
                  throw state.terminalError ?? self.lastDisconnectError;
                return;
              }
              if (value !== undefined) yield value;
            } else if (state.closed) {
              if (state.terminalError ?? self.lastDisconnectError)
                throw state.terminalError ?? self.lastDisconnectError;
              return;
            } else {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
          }
        } finally {
          self.feeds.delete(feedHash);
          self.pendingFeedChunks.delete(feedHash);
          const activeSocket = self.socket;
          if (!activeSocket || !self.isOpen(activeSocket)) return;
          try {
            self.sendJson(activeSocket, {
              route,
              op: "signal",
              feed: feedHash,
              method: ScompFrameworkMethods.UNSUBSCRIBE,
              payload: {},
            });
          } catch (error) {
            if (!(error instanceof SocketDisconnectedError)) throw error;
          }
        }
      },
    };
  }

  private resolveWebSocketCtor(): BrowserWebSocketCtor {
    if (this.config.webSocketCtor) return this.config.webSocketCtor;
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error(
        "No WebSocket constructor found. Provide config.webSocketCtor in non-browser environments.",
      );
    }
    return globalThis.WebSocket as unknown as BrowserWebSocketCtor;
  }

  private isOpen(socket: BrowserSocket): boolean {
    const openState = typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1;
    return socket.readyState === openState;
  }

  private async getSocket(): Promise<BrowserSocket> {
    if (this.socket && this.isOpen(this.socket)) return this.socket;
    if (this.openingPromise) return this.openingPromise;

    this.openingPromise = new Promise<BrowserSocket>((resolve, reject) => {
      const WebSocketCtor = this.resolveWebSocketCtor();
      const socket = new WebSocketCtor(this.config.url, this.config.protocols);

      const onOpen = () => {
        cleanup();
        this.socket = socket;
        this.lastDisconnectError = undefined;
        this.attachSocketHandlers(socket);
        this.openingPromise = undefined;
        resolve(socket);
      };
      const onError = (event: Event) => {
        cleanup();
        this.openingPromise = undefined;
        reject(event);
      };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen as EventListener);
        socket.removeEventListener("error", onError as EventListener);
      };

      socket.addEventListener("open", onOpen as EventListener, { once: true });
      socket.addEventListener("error", onError as EventListener, {
        once: true,
      });
    });

    return this.openingPromise;
  }

  private attachSocketHandlers(socket: BrowserSocket): void {
    socket.addEventListener("message", (event: MessageEvent) => {
      void (async () => {
        const parsed = safeJsonParse(await toText(event.data));
        if (!parsed.ok) return;
        this.handleIncoming(parsed.value as TransportMessage);
      })();
    });
    socket.addEventListener("close", () =>
      this.onDisconnect(new SocketDisconnectedError()),
    );
    socket.addEventListener("error", (event) => this.onDisconnect(event));
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
      enqueueFeedChunk(feed, message);
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
    if (!allowed) throw new Error(`${op} not authorized for route: ${route}`);
    const id = randomUUID();

    const response = new Promise<unknown>((resolve, reject) => {
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

    this.sendJson(socket, envelope);
    return response;
  }

  private sendJson(socket: BrowserSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload));
  }

  private async resolveMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const metaConfig = this.config.meta;
    if (!metaConfig) return undefined;
    if (typeof metaConfig === "function") return metaConfig();
    return metaConfig;
  }

  /**
   * Deterministic outbound meta precedence (Node client parity):
   * config.meta -> options.meta -> priority hints -> principal-derived auth context.
   */
  private async composeOutboundMeta(
    options: ScompClientInvokeOptions | undefined,
    principal: ScompTransportPrincipal | undefined,
  ): Promise<ScompTransportMessageMeta | undefined> {
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = mergeMeta(baseMeta, priorityMeta);
    return mergeMeta(effectiveMeta, toPrincipalMeta(principal));
  }
}

export function createWebSocketBrowserTransport(
  config: WebSocketBrowserTransportConfig,
): WebSocketBrowserTransport {
  return new WebSocketBrowserTransport(config);
}

export {
  SocketDisconnectedError,
  type WebSocketBrowserTransportConfig,
} from "./types";
