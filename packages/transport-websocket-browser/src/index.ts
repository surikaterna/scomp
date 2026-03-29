import { randomUUID } from "node:crypto";
import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportOperation,
  ScompTransportPrincipal,
  ScompTransportSecurityContext,
  ScompTransportSecurityPolicy,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scomp/types";

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

type BrowserSocket = Pick<
  WebSocket,
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
  | "readyState"
>;

type BrowserWebSocketCtor = new (
  url: string,
  protocols?: string | Array<string>,
) => BrowserSocket;

type TransportMessage =
  | ScompTransportRequestEnvelope
  | ScompTransportResponseEnvelope
  | ScompFeedChunkEnvelope;

export interface WebSocketBrowserTransportConfig {
  url: string;
  protocols?: string | Array<string>;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
  webSocketCtor?: BrowserWebSocketCtor;
}

function toPriorityMeta(
  options?: ScompClientInvokeOptions,
): ScompTransportMessageMeta | undefined {
  if (!options) {
    return undefined;
  }

  const { priority, priorityClass, deadlineAtMs, targetLatencyMs } = options;
  if (
    priority === undefined &&
    priorityClass === undefined &&
    deadlineAtMs === undefined &&
    targetLatencyMs === undefined
  ) {
    return undefined;
  }

  const meta: ScompTransportMessageMeta = {};
  if (priority !== undefined) {
    meta.priority = priority;
  }
  if (priorityClass !== undefined) {
    meta.priorityClass = priorityClass;
  }
  if (deadlineAtMs !== undefined) {
    meta.deadlineAtMs = deadlineAtMs;
  }
  if (targetLatencyMs !== undefined) {
    meta.targetLatencyMs = targetLatencyMs;
  }

  return meta;
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isFeedChunkEnvelope(
  message: TransportMessage,
): message is ScompFeedChunkEnvelope {
  return (message as ScompFeedChunkEnvelope).channel === "feed";
}

async function toText(data: unknown): Promise<string> {
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

export class WebSocketBrowserTransport implements ITransport {
  private readonly config: WebSocketBrowserTransportConfig;
  private socket?: BrowserSocket;
  private openingPromise?: Promise<BrowserSocket>;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly feeds = new Map<string, FeedState>();
  private readonly pendingFeedChunks = new Map<
    string,
    Array<ScompFeedChunkEnvelope>
  >();

  constructor(config: WebSocketBrowserTransportConfig) {
    this.config = config;
  }

  async listen(_router: Record<string, unknown>): Promise<void> {
    throw new Error(
      "WebSocketBrowserTransport.listen() is not supported. Use WebSocketServerTransport to host routes.",
    );
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
    const baseMeta = this.mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = this.mergeMeta(baseMeta, priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
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

    const outboundMeta = await this.composeOutboundMeta(options, principal);

    this.sendJson(socket, {
      route,
      op: "signal",
      payload,
      meta: outboundMeta,
    });
  }

  feed(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<any> {
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const handshake = await self.sendRpc(
          route,
          "feed_start",
          payload,
          options,
        );
        const feedHash = String(handshake?.hash ?? "");

        if (!feedHash) {
          throw new Error("Feed start response did not include a hash.");
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
          await self.sendRpc(route, "feed_stop", { hash: feedHash }, options);
        }
      },
    };
  }

  private resolveWebSocketCtor(): BrowserWebSocketCtor {
    if (this.config.webSocketCtor) {
      return this.config.webSocketCtor;
    }

    if (typeof globalThis.WebSocket !== "function") {
      throw new Error(
        "No WebSocket constructor found. Provide config.webSocketCtor in non-browser environments.",
      );
    }

    return globalThis.WebSocket as unknown as BrowserWebSocketCtor;
  }

  private isOpen(socket: BrowserSocket): boolean {
    const openState =
      typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1;
    return socket.readyState === openState;
  }

  private async getSocket(): Promise<BrowserSocket> {
    if (this.socket && this.isOpen(this.socket)) {
      return this.socket;
    }

    if (this.openingPromise) {
      return this.openingPromise;
    }

    this.openingPromise = new Promise<BrowserSocket>((resolve, reject) => {
      const WebSocketCtor = this.resolveWebSocketCtor();
      const socket = new WebSocketCtor(this.config.url, this.config.protocols);

      const onOpen = () => {
        cleanup();
        this.socket = socket;
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
        const message = safeJsonParse(await toText(event.data)) as TransportMessage;
        this.handleIncoming(message);
      })();
    });

    socket.addEventListener("close", () => {
      this.handleDisconnect(new SocketDisconnectedError());
    });

    socket.addEventListener("error", (event) => {
      this.handleDisconnect(event);
    });
  }

  private handleIncoming(message: TransportMessage): void {
    if (isFeedChunkEnvelope(message)) {
      const hash = String(message.hash ?? "");
      const feed = this.feeds.get(hash);
      if (!feed) {
        const pending = this.pendingFeedChunks.get(hash) ?? [];
        pending.push(message);
        this.pendingFeedChunks.set(hash, pending);
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

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const feed of this.feeds.values()) {
      feed.closed = true;
      feed.queue.push(
        Promise.reject(
          error instanceof Error
            ? error
            : new SocketDisconnectedError(String(error)),
        ),
      );
      const waiter = feed.waiters.shift();
      waiter?.();
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
    const baseMeta = this.mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = this.mergeMeta(baseMeta, priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
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

    const outboundMeta = await this.composeOutboundMeta(options, principal);

    this.sendJson(socket, {
      id,
      route,
      op,
      payload,
      meta: outboundMeta,
    } satisfies ScompTransportRequestEnvelope);

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

  private enqueueFeedChunk(feed: FeedState, message: ScompFeedChunkEnvelope): void {
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

  private sendJson(socket: BrowserSocket, payload: unknown): void {
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

  private toPrincipalMeta(
    principal: ScompTransportPrincipal | undefined,
  ): ScompTransportMessageMeta | undefined {
    if (!principal) {
      return undefined;
    }

    return {
      auth: {
        subject: principal.subject,
        tenantId: principal.tenantId,
        scopes: principal.scopes,
        claims: principal.claims,
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
        authType: principal.authType,
      },
      tenantId: principal.tenantId,
    };
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
    const baseMeta = this.mergeMeta(await this.resolveMeta(), options?.meta);
    const effectiveMeta = this.mergeMeta(baseMeta, priorityMeta);
    return this.mergeMeta(effectiveMeta, this.toPrincipalMeta(principal));
  }

  private mergeMeta(
    baseMeta: ScompTransportMessageMeta | undefined,
    overlayMeta: ScompTransportMessageMeta | undefined,
  ): ScompTransportMessageMeta | undefined {
    if (!baseMeta && !overlayMeta) {
      return undefined;
    }

    return {
      ...(baseMeta ?? {}),
      ...(overlayMeta ?? {}),
    };
  }

  private async checkSecurity(
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
    const policy = this.config.security;
    if (!policy) {
      return { allowed: true };
    }

    const principal = policy.authenticate
      ? await policy.authenticate(ctx)
      : undefined;

    if (!policy.authorize) {
      return { allowed: true, principal: principal ?? undefined };
    }

    const allowed = Boolean(
      await policy.authorize({
        ...ctx,
        principal: principal ?? undefined,
      }),
    );

    return { allowed, principal: principal ?? undefined };
  }
}

export function createWebSocketBrowserTransport(
  config: WebSocketBrowserTransportConfig,
): WebSocketBrowserTransport {
  return new WebSocketBrowserTransport(config);
}
