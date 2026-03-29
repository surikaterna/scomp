import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type {
  CompiledRoute,
  ITransport,
  ScompClientInvokeOptions,
} from "@scomp/core";
import {
  createFeedHash,
  type ScompFeedChunkEnvelope,
  type ScompTransportMessageMeta,
  type ScompTransportPrincipal,
  type ScompTransportSecurityContext,
  type ScompTransportSecurityPolicy,
  type ScompTransportRequestEnvelope,
  type ScompTransportResponseEnvelope,
} from "@scomp/types";
import {
  WebSocketClientTransport,
  type WebSocketClientTransportConfig,
} from "@scomp/transport-websocket-client";
import WebSocket, { type RawData, WebSocketServer } from "ws";

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = "StreamClosedError";
  }
}

interface RunningFeed {
  key: string;
  exchange: string;
  subscribers: Set<WebSocket>;
  abortController: AbortController;
}

type TransportMessage = ScompTransportRequestEnvelope;

export interface WebSocketServerTransportConfig {
  port?: number;
  host?: string;
  path?: string;
  server?: HttpServer | HttpsServer;
  outbound?: WebSocketClientTransportConfig | WebSocketClientTransport;
  security?: ScompTransportSecurityPolicy;
}

interface SocketWithPrincipal extends WebSocket {
  scompPrincipal?: ScompTransportPrincipal;
}

type RouterTable = Record<string, CompiledRoute>;

const WS_OPEN_STATE = 1;

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

function toTextFromBunMessage(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }

  if (data === null || data === undefined) {
    return "";
  }

  return String(data);
}

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

function ensureFeedIterable(value: unknown): AsyncIterable<unknown> {
  if (
    value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  ) {
    return value as AsyncIterable<unknown>;
  }

  throw new Error("Feed route handler did not return an AsyncIterable.");
}

interface BunWebSocketLike<Data extends object = Record<string, unknown>> {
  readonly data: Data;
  readonly readyState?: number;
  send(message: string): unknown;
}

interface BunUpgradeServer {
  upgrade(
    request: Request,
    options?: {
      data?: Record<string, unknown>;
    },
  ): boolean;
}

type BunFetchHandler = (
  request: Request,
  server: BunUpgradeServer,
) => Response | void | Promise<Response | void>;

interface BunWebSocketHandler {
  open?: (socket: BunWebSocketLike<BunSocketState>) => void;
  message?: (socket: BunWebSocketLike<BunSocketState>, message: unknown) => void;
  close?: (
    socket: BunWebSocketLike<BunSocketState>,
    code: number,
    reason: string,
  ) => void;
}

interface BunSocketState {
  scompPrincipal?: ScompTransportPrincipal;
}

interface BunRunningFeed {
  key: string;
  exchange: string;
  subscribers: Set<BunWebSocketLike<BunSocketState>>;
  abortController: AbortController;
}

interface BunSocketWithPrincipal extends BunWebSocketLike<BunSocketState> {
  data: BunSocketState;
}

export interface BunWebSocketServerTransportConfig {
  path?: string;
  outbound?: WebSocketClientTransportConfig | WebSocketClientTransport;
  security?: ScompTransportSecurityPolicy;
  onHttpRequest?: (request: Request) => Response | Promise<Response>;
}

export class WebSocketServerTransport implements ITransport {
  private readonly config: WebSocketServerTransportConfig;
  private server?: WebSocketServer;
  private router?: RouterTable;
  private readonly sockets = new Set<WebSocket>();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private outboundTransport?: ITransport;

  constructor(config: WebSocketServerTransportConfig) {
    this.config = config;
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
    const server = this.getServer();

    if (server.listenerCount("connection") > 0) {
      return;
    }

    server.on("connection", (socket: WebSocket) => {
      this.sockets.add(socket);

      socket.on("message", async (data: RawData) => {
        const body = safeJsonParse(toText(data)) as TransportMessage;
        await this.handleIncoming(socket as SocketWithPrincipal, body);
      });

      socket.on("close", () => {
        this.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
      });

      socket.on("error", () => {
        this.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
      });
    });
  }

  async request(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    const transport = this.getOutboundTransport();
    return transport.request(route, payload, options);
  }

  async signal(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const transport = this.getOutboundTransport();
    await transport.signal(route, payload, options);
  }

  feed(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<any> {
    const transport = this.getOutboundTransport();
    return transport.feed(route, payload, options);
  }

  private getOutboundTransport(): ITransport {
    if (this.outboundTransport) {
      return this.outboundTransport;
    }

    const outboundConfig = this.config.outbound;
    if (!outboundConfig) {
      throw new Error(
        "WebSocketServerTransport outbound is not configured. Provide config.outbound to use request/signal/feed.",
      );
    }

    this.outboundTransport =
      outboundConfig instanceof WebSocketClientTransport
        ? outboundConfig
        : new WebSocketClientTransport(outboundConfig);

    return this.outboundTransport;
  }

  private getServer(): WebSocketServer {
    if (this.server) {
      return this.server;
    }

    if (this.config.server) {
      this.server = new WebSocketServer({
        server: this.config.server,
        path: this.config.path,
      });
      return this.server;
    }

    if (!this.config.port) {
      throw new Error(
        "WebSocketServerTransport requires either a port or an existing HTTP server.",
      );
    }

    this.server = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
      path: this.config.path,
    });

    return this.server;
  }

  private async handleIncoming(
    socket: SocketWithPrincipal,
    body: TransportMessage,
  ): Promise<void> {
    const routeName = String(body.route ?? "");
    const routeEntry = this.router?.[routeName];
    const op = body.op ?? "request";

    const { allowed, principal } = await this.checkSecurity(socket, {
      direction: "inbound",
      transport: "websocket",
      route: routeName,
      operation: op,
      payload: body.payload,
      meta: body.meta,
    });

    if (!allowed) {
      if (body.id) {
        this.replyWithError(
          socket,
          body.id,
          `Inbound operation not authorized for route: ${routeName}`,
          this.toPrincipalMeta(principal),
        );
      }
      return;
    }

    if (!routeEntry) {
      if (body.id) {
        this.replyWithError(
          socket,
          body.id,
          `Route not found: ${routeName}`,
          this.toPrincipalMeta(principal),
        );
      }
      return;
    }

    if (routeEntry.kind === "feed") {
      await this.handleFeedRpc(socket, routeEntry, body, op);
      return;
    }

    if (op === "signal" || routeEntry.kind === "signal") {
      try {
        await this.invokeRoute(routeEntry, body);
      } catch {
        // Signals are fire-and-forget and do not reply.
      }
      return;
    }

    try {
      const result = await this.invokeRoute(routeEntry, body);
      this.replyWithPayload(
        socket,
        body.id,
        result,
        this.toPrincipalMeta(principal),
      );
    } catch (error) {
      this.replyWithError(
        socket,
        body.id,
        error,
        this.toPrincipalMeta(principal),
      );
    }
  }

  private async handleFeedRpc(
    socket: WebSocket,
    route: CompiledRoute,
    body: TransportMessage,
    op: string,
  ): Promise<void> {
    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const payloadRecord =
      body.payload && typeof body.payload === "object"
        ? (body.payload as { hash?: unknown })
        : undefined;
    const hash = String(
      payloadRecord?.hash ??
        createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }),
    );

    if (op === "feed_stop") {
      const running = this.runningFeeds.get(hash);
      if (running) {
        running.subscribers.delete(socket);
        if (running.subscribers.size === 0) {
          running.abortController.abort(new StreamClosedError(hash));
        }
      }

      this.replyWithPayload(socket, body.id, { ok: true });
      return;
    }

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers.add(socket);
      this.replyWithPayload(socket, body.id, {
        exchange: existing.exchange,
        hash,
      });
      return;
    }

    const runningFeed: RunningFeed = {
      key: hash,
      exchange: toFeedExchange(hash),
      subscribers: new Set([socket]),
      abortController: new AbortController(),
    };

    this.runningFeeds.set(hash, runningFeed);
    this.replyWithPayload(socket, body.id, {
      exchange: runningFeed.exchange,
      hash,
    });

    const iterable = ensureFeedIterable(route.handler(parsedPayload));
    setImmediate(() => {
      void this.publishFeed(runningFeed, iterable);
    });
  }

  private async publishFeed(
    runningFeed: RunningFeed,
    iterable: AsyncIterable<unknown>,
  ): Promise<void> {
    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        this.broadcastFeedChunk(runningFeed, {
          hash: runningFeed.key,
          type: "next",
          payload: chunk,
        });
      }

      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: "done",
      });
    } catch (error) {
      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningFeeds.delete(runningFeed.key);
    }
  }

  private broadcastFeedChunk(
    runningFeed: RunningFeed,
    chunk: {
      hash: string;
      type: "next" | "done" | "error";
      payload?: unknown;
      message?: string;
    },
  ): void {
    const payload = JSON.stringify({
      channel: "feed",
      ...chunk,
    } satisfies ScompFeedChunkEnvelope);

    for (const socket of runningFeed.subscribers) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      socket.send(payload);
    }
  }

  private detachSocketFromFeeds(socket: WebSocket): void {
    for (const runningFeed of this.runningFeeds.values()) {
      if (!runningFeed.subscribers.has(socket)) {
        continue;
      }

      runningFeed.subscribers.delete(socket);
      if (runningFeed.subscribers.size === 0) {
        runningFeed.abortController.abort(
          new StreamClosedError(runningFeed.key),
        );
      }
    }
  }

  private async invokeRoute(
    route: CompiledRoute,
    message: TransportMessage,
  ): Promise<unknown> {
    const rawPayload = message.payload;
    const payload = route.parser ? route.parser(rawPayload) : rawPayload;
    return route.handler(payload);
  }

  private replyWithPayload(
    socket: WebSocket,
    id: string | undefined,
    payload: unknown,
    meta?: ScompTransportMessageMeta,
  ): void {
    if (!id || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        id,
        payload,
        meta,
      } satisfies ScompTransportResponseEnvelope),
    );
  }

  private replyWithError(
    socket: WebSocket,
    id: string | undefined,
    error: unknown,
    meta?: ScompTransportMessageMeta,
  ): void {
    if (!id || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        id,
        error: error instanceof Error ? error.message : String(error),
        meta,
      } satisfies ScompTransportResponseEnvelope),
    );
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

  private async checkSecurity(
    socket: SocketWithPrincipal,
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
    const policy = this.config.security;
    if (!policy) {
      return { allowed: true, principal: socket.scompPrincipal };
    }

    const principal = policy.authenticate
      ? await policy.authenticate(ctx)
      : (socket.scompPrincipal ?? undefined);

    if (principal) {
      socket.scompPrincipal = principal;
    }

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

export class BunWebSocketServerTransport implements ITransport {
  private readonly config: BunWebSocketServerTransportConfig;
  private readonly path: string;
  private router?: RouterTable;
  private readonly sockets = new Set<BunWebSocketLike<BunSocketState>>();
  private readonly runningFeeds = new Map<string, BunRunningFeed>();
  private outboundTransport?: ITransport;

  readonly fetch: BunFetchHandler;
  readonly websocket: BunWebSocketHandler;

  constructor(config: BunWebSocketServerTransportConfig = {}) {
    this.config = config;
    this.path = config.path ?? "/";
    this.fetch = this.handleFetch.bind(this);
    this.websocket = {
      open: this.handleOpen.bind(this),
      message: this.handleMessage.bind(this),
      close: this.handleClose.bind(this),
    };
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
  }

  async request(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    const transport = this.getOutboundTransport();
    return transport.request(route, payload, options);
  }

  async signal(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const transport = this.getOutboundTransport();
    await transport.signal(route, payload, options);
  }

  feed(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<any> {
    const transport = this.getOutboundTransport();
    return transport.feed(route, payload, options);
  }

  private getOutboundTransport(): ITransport {
    if (this.outboundTransport) {
      return this.outboundTransport;
    }

    const outboundConfig = this.config.outbound;
    if (!outboundConfig) {
      throw new Error(
        "BunWebSocketServerTransport outbound is not configured. Provide config.outbound to use request/signal/feed.",
      );
    }

    this.outboundTransport =
      outboundConfig instanceof WebSocketClientTransport
        ? outboundConfig
        : new WebSocketClientTransport(outboundConfig);

    return this.outboundTransport;
  }

  private async handleFetch(
    request: Request,
    server: BunUpgradeServer,
  ): Promise<Response | void> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== this.path) {
      if (this.config.onHttpRequest) {
        return this.config.onHttpRequest(request);
      }
      return new Response("Not Found", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: {},
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return;
  }

  private handleOpen(socket: BunWebSocketLike<BunSocketState>): void {
    this.sockets.add(socket);
  }

  private handleMessage(
    socket: BunWebSocketLike<BunSocketState>,
    message: unknown,
  ): void {
    const body = safeJsonParse(toTextFromBunMessage(message)) as TransportMessage;
    void this.handleIncoming(socket as BunSocketWithPrincipal, body);
  }

  private handleClose(socket: BunWebSocketLike<BunSocketState>): void {
    this.detachSocketFromFeeds(socket);
    this.sockets.delete(socket);
  }

  private async handleIncoming(
    socket: BunSocketWithPrincipal,
    body: TransportMessage,
  ): Promise<void> {
    const routeName = String(body.route ?? "");
    const routeEntry = this.router?.[routeName];
    const op = body.op ?? "request";

    const { allowed, principal } = await this.checkSecurity(socket, {
      direction: "inbound",
      transport: "websocket",
      route: routeName,
      operation: op,
      payload: body.payload,
      meta: body.meta,
    });

    if (!allowed) {
      if (body.id) {
        this.replyWithError(
          socket,
          body.id,
          `Inbound operation not authorized for route: ${routeName}`,
          this.toPrincipalMeta(principal),
        );
      }
      return;
    }

    if (!routeEntry) {
      if (body.id) {
        this.replyWithError(
          socket,
          body.id,
          `Route not found: ${routeName}`,
          this.toPrincipalMeta(principal),
        );
      }
      return;
    }

    if (routeEntry.kind === "feed") {
      await this.handleFeedRpc(socket, routeEntry, body, op);
      return;
    }

    if (op === "signal" || routeEntry.kind === "signal") {
      try {
        await this.invokeRoute(routeEntry, body);
      } catch {
        // Signals are fire-and-forget and do not reply.
      }
      return;
    }

    try {
      const result = await this.invokeRoute(routeEntry, body);
      this.replyWithPayload(
        socket,
        body.id,
        result,
        this.toPrincipalMeta(principal),
      );
    } catch (error) {
      this.replyWithError(
        socket,
        body.id,
        error,
        this.toPrincipalMeta(principal),
      );
    }
  }

  private async handleFeedRpc(
    socket: BunWebSocketLike<BunSocketState>,
    route: CompiledRoute,
    body: TransportMessage,
    op: string,
  ): Promise<void> {
    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const payloadRecord =
      body.payload && typeof body.payload === "object"
        ? (body.payload as { hash?: unknown })
        : undefined;
    const hash = String(
      payloadRecord?.hash ??
        createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }),
    );

    if (op === "feed_stop") {
      const running = this.runningFeeds.get(hash);
      if (running) {
        running.subscribers.delete(socket);
        if (running.subscribers.size === 0) {
          running.abortController.abort(new StreamClosedError(hash));
        }
      }

      this.replyWithPayload(socket, body.id, { ok: true });
      return;
    }

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers.add(socket);
      this.replyWithPayload(socket, body.id, {
        exchange: existing.exchange,
        hash,
      });
      return;
    }

    const runningFeed: BunRunningFeed = {
      key: hash,
      exchange: toFeedExchange(hash),
      subscribers: new Set([socket]),
      abortController: new AbortController(),
    };

    this.runningFeeds.set(hash, runningFeed);
    this.replyWithPayload(socket, body.id, {
      exchange: runningFeed.exchange,
      hash,
    });

    const iterable = ensureFeedIterable(route.handler(parsedPayload));
    queueMicrotask(() => {
      void this.publishFeed(runningFeed, iterable);
    });
  }

  private async publishFeed(
    runningFeed: BunRunningFeed,
    iterable: AsyncIterable<unknown>,
  ): Promise<void> {
    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        this.broadcastFeedChunk(runningFeed, {
          hash: runningFeed.key,
          type: "next",
          payload: chunk,
        });
      }

      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: "done",
      });
    } catch (error) {
      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningFeeds.delete(runningFeed.key);
    }
  }

  private broadcastFeedChunk(
    runningFeed: BunRunningFeed,
    chunk: {
      hash: string;
      type: "next" | "done" | "error";
      payload?: unknown;
      message?: string;
    },
  ): void {
    const payload = JSON.stringify({
      channel: "feed",
      ...chunk,
    } satisfies ScompFeedChunkEnvelope);

    for (const socket of runningFeed.subscribers) {
      if (socket.readyState !== undefined && socket.readyState !== WS_OPEN_STATE) {
        continue;
      }

      socket.send(payload);
    }
  }

  private detachSocketFromFeeds(socket: BunWebSocketLike<BunSocketState>): void {
    for (const runningFeed of this.runningFeeds.values()) {
      if (!runningFeed.subscribers.has(socket)) {
        continue;
      }

      runningFeed.subscribers.delete(socket);
      if (runningFeed.subscribers.size === 0) {
        runningFeed.abortController.abort(new StreamClosedError(runningFeed.key));
      }
    }
  }

  private async invokeRoute(
    route: CompiledRoute,
    message: TransportMessage,
  ): Promise<unknown> {
    const rawPayload = message.payload;
    const payload = route.parser ? route.parser(rawPayload) : rawPayload;
    return route.handler(payload);
  }

  private replyWithPayload(
    socket: BunWebSocketLike<BunSocketState>,
    id: string | undefined,
    payload: unknown,
    meta?: ScompTransportMessageMeta,
  ): void {
    if (!id) {
      return;
    }

    if (socket.readyState !== undefined && socket.readyState !== WS_OPEN_STATE) {
      return;
    }

    socket.send(
      JSON.stringify({
        id,
        payload,
        meta,
      } satisfies ScompTransportResponseEnvelope),
    );
  }

  private replyWithError(
    socket: BunWebSocketLike<BunSocketState>,
    id: string | undefined,
    error: unknown,
    meta?: ScompTransportMessageMeta,
  ): void {
    if (!id) {
      return;
    }

    if (socket.readyState !== undefined && socket.readyState !== WS_OPEN_STATE) {
      return;
    }

    socket.send(
      JSON.stringify({
        id,
        error: error instanceof Error ? error.message : String(error),
        meta,
      } satisfies ScompTransportResponseEnvelope),
    );
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

  private async checkSecurity(
    socket: BunSocketWithPrincipal,
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
    const policy = this.config.security;
    if (!policy) {
      return { allowed: true, principal: socket.data.scompPrincipal };
    }

    const principal = policy.authenticate
      ? await policy.authenticate(ctx)
      : (socket.data.scompPrincipal ?? undefined);

    if (principal) {
      socket.data.scompPrincipal = principal;
    }

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

export function createWebSocketServerTransport(
  config: WebSocketServerTransportConfig,
): WebSocketServerTransport {
  return new WebSocketServerTransport(config);
}

export function createBunWebSocketServerTransport(
  config: BunWebSocketServerTransportConfig = {},
): BunWebSocketServerTransport {
  return new BunWebSocketServerTransport(config);
}
