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

type TransportMessage =
  | ScompTransportRequestEnvelope
  | ScompTransportResponseEnvelope
  | ScompFeedChunkEnvelope;

export interface WebSocketClientTransportConfig {
  url: string;
  protocols?: string | Array<string>;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
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

function isFeedChunkEnvelope(
  message: TransportMessage,
): message is ScompFeedChunkEnvelope {
  return (message as ScompFeedChunkEnvelope).channel === "feed";
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

  async listen(_router: Record<string, unknown>): Promise<void> {
    throw new Error(
      "WebSocketClientTransport.listen() is not supported. Use WebSocketServerTransport to host routes.",
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
    this.sendJson(socket, {
      route,
      op: "signal",
      payload,
      meta: this.mergeMeta(
        effectiveMeta,
        this.toPrincipalMeta(principal),
      ),
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
          await self.sendRpc(
            route,
            "feed_stop",
            { hash: feedHash },
            options,
          );
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
      const message = safeJsonParse(toText(data)) as TransportMessage;
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

    this.sendJson(socket, {
      id,
      route,
      op,
      payload,
      meta: this.mergeMeta(effectiveMeta, this.toPrincipalMeta(principal)),
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

  private mergeMeta(
    baseMeta: ScompTransportMessageMeta | undefined,
    principalMeta: ScompTransportMessageMeta | undefined,
  ): ScompTransportMessageMeta | undefined {
    if (!baseMeta && !principalMeta) {
      return undefined;
    }

    return {
      ...(baseMeta ?? {}),
      ...(principalMeta ?? {}),
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

export function createWebSocketClientTransport(
  config: WebSocketClientTransportConfig,
): WebSocketClientTransport {
  return new WebSocketClientTransport(config);
}
