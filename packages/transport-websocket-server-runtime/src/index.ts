import {
  SCOMP_FRAMEWORK_PREFIX,
  ScompFrameworkMethods,
  type CompiledRoute,
  type ControlledAsyncIterable,
} from "@scomp/core";
import {
  createFeedHash,
  type ScompErrorCode,
  type ScompFeedChunkEnvelope,
  type ScompTransportMessageMeta,
  type ScompTransportPrincipal,
  type ScompTransportRequestEnvelope,
  type ScompTransportResponseEnvelope,
  type ScompTransportSecurityContext,
  type ScompTransportSecurityPolicy,
} from "@scomp/types";

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = "StreamClosedError";
  }
}

export interface RuntimeSocket {
  readyState: number;
  send(payload: string): void;
}

interface RunningFeed<Socket extends RuntimeSocket> {
  key: string;
  exchange: string;
  subscribers: Set<Socket>;
  abortController: AbortController;
  controller?: Record<string, (payload: unknown) => unknown>;
}

export type TransportMessage = ScompTransportRequestEnvelope;

type CheckSecurityResult = {
  allowed: boolean;
  principal?: ScompTransportPrincipal;
};

type RuntimeHandlers<Socket extends RuntimeSocket> = {
  invokeRoute: (
    route: CompiledRoute,
    message: TransportMessage,
  ) => Promise<unknown>;
  isSocketOpen: (socket: Socket) => boolean;
  onReply: (socket: Socket, response: ScompTransportResponseEnvelope) => void;
  onFeedChunk: (socket: Socket, chunk: ScompFeedChunkEnvelope) => void;
  onFeedExchange: (hash: string) => string;
  toPrincipalMeta?: (
    principal: ScompTransportPrincipal | undefined,
  ) => ScompTransportMessageMeta | undefined;
};

export type WebSocketServerRuntimeConfig<Socket extends RuntimeSocket> = {
  security?: ScompTransportSecurityPolicy;
  getSocketPrincipal: (socket: Socket) => ScompTransportPrincipal | undefined;
  setSocketPrincipal: (
    socket: Socket,
    principal: ScompTransportPrincipal,
  ) => void;
} & RuntimeHandlers<Socket>;

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function parseTransportMessage(text: string): TransportMessage {
  return safeJsonParse(text) as TransportMessage;
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

function isControlledAsyncIterable(
  value: unknown,
): value is ControlledAsyncIterable<unknown, Record<string, Function>> {
  return (
    value != null &&
    typeof (value as ControlledAsyncIterable<unknown>).controller ===
      "object" &&
    (value as ControlledAsyncIterable<unknown>).controller !== null
  );
}

function defaultToPrincipalMeta(
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

export class WebSocketServerRuntime<Socket extends RuntimeSocket> {
  private router?: Record<string, CompiledRoute>;
  private readonly runningFeeds = new Map<string, RunningFeed<Socket>>();
  /**
   * Shared controllers for fanout feeds, keyed by route+feedHash.
   * Multiple RunningFeed entries may reference the same shared controller.
   */
  private readonly sharedControllers = new Map<
    string,
    Record<string, (payload: unknown) => unknown>
  >();

  constructor(private readonly config: WebSocketServerRuntimeConfig<Socket>) {}

  setRouter(router: Record<string, CompiledRoute>): void {
    this.router = router;
  }

  async handleIncoming(socket: Socket, body: TransportMessage): Promise<void> {
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

    const meta = (this.config.toPrincipalMeta ?? defaultToPrincipalMeta)(
      principal,
    );

    if (!allowed) {
      this.replyWithError(
        socket,
        body.id,
        `Inbound operation not authorized for route: ${routeName}`,
        meta,
        "UNAUTHORIZED",
      );
      return;
    }

    if (!routeEntry) {
      this.replyWithError(
        socket,
        body.id,
        `Route not found: ${routeName}`,
        meta,
        "ROUTE_NOT_FOUND",
      );
      return;
    }

    if (
      op === "signal" &&
      body.method === ScompFrameworkMethods.UNSUBSCRIBE &&
      body.feed
    ) {
      this.handleFeedUnsubscribe(socket, body);
      return;
    }

    if (body.feed && body.method) {
      await this.handleControllerCall(socket, body, meta);
      return;
    }

    if (routeEntry.kind === "feed") {
      await this.handleFeedRpc(socket, routeEntry, body);
      return;
    }

    if (op === "signal" || routeEntry.kind === "signal") {
      try {
        await this.config.invokeRoute(routeEntry, body);
      } catch {
        // Signals are fire-and-forget and do not reply.
      }
      return;
    }

    try {
      const result = await this.config.invokeRoute(routeEntry, body);
      this.replyWithPayload(socket, body.id, result, meta);
    } catch (error) {
      this.replyWithError(socket, body.id, error, meta);
    }
  }

  detachSocketFromFeeds(socket: Socket): void {
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

  private handleFeedUnsubscribe(socket: Socket, body: TransportMessage): void {
    const feedId = String(body.feed ?? "");
    if (!feedId) {
      this.replyWithPayload(socket, body.id, { ok: true });
      return;
    }

    const running = this.runningFeeds.get(feedId);
    if (running) {
      running.subscribers.delete(socket);
      if (running.subscribers.size === 0) {
        running.abortController.abort(new StreamClosedError(feedId));
      }
    }

    this.replyWithPayload(socket, body.id, { ok: true });
  }

  private async handleControllerCall(
    socket: Socket,
    body: TransportMessage,
    meta?: ScompTransportMessageMeta,
  ): Promise<void> {
    const feedId = String(body.feed ?? "");
    const method = String(body.method ?? "");

    const running = this.runningFeeds.get(feedId);
    if (!running) {
      this.replyWithError(
        socket,
        body.id,
        `Feed not found: ${feedId}`,
        meta,
        "FEED_NOT_FOUND",
      );
      return;
    }

    if (method.startsWith(SCOMP_FRAMEWORK_PREFIX)) {
      this.replyWithError(
        socket,
        body.id,
        `Framework method not implemented: ${method}`,
        meta,
        "CONTROLLER_NOT_FOUND",
      );
      return;
    }

    const controller = running.controller;
    if (!controller || typeof controller[method] !== "function") {
      this.replyWithError(
        socket,
        body.id,
        `Controller method not found: ${method}`,
        meta,
        "CONTROLLER_NOT_FOUND",
      );
      return;
    }

    if ((body.op ?? "request") === "signal") {
      try {
        await controller[method](body.payload);
      } catch {
        // Signals are fire-and-forget and do not reply.
      }
      return;
    }

    try {
      const result = await controller[method](body.payload);
      this.replyWithPayload(socket, body.id, result, meta);
    } catch (error) {
      this.replyWithError(socket, body.id, error, meta);
    }
  }

  private async handleFeedRpc(
    socket: Socket,
    route: CompiledRoute,
    body: TransportMessage,
  ): Promise<void> {
    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const hash = String(
      body.feed ??
        createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }),
    );

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers.add(socket);
      this.replyWithPayload(socket, body.id, {
        exchange: existing.exchange,
        feed: hash,
      });
      return;
    }

    const runningFeed: RunningFeed<Socket> = {
      key: hash,
      exchange: this.config.onFeedExchange(hash),
      subscribers: new Set([socket]),
      abortController: new AbortController(),
    };

    this.runningFeeds.set(hash, runningFeed);
    this.replyWithPayload(socket, body.id, {
      exchange: runningFeed.exchange,
      feed: hash,
    });

    const result = await this.config.invokeRoute(route, body);
    const iterable = ensureFeedIterable(result);

    if (isControlledAsyncIterable(result)) {
      const controllerRef = result.controller as Record<
        string,
        (payload: unknown) => unknown
      >;

      if (result.__scope === "fanout") {
        const existing = this.sharedControllers.get(hash);
        runningFeed.controller = existing ?? controllerRef;
        if (!existing) {
          this.sharedControllers.set(hash, controllerRef);
        }
      } else {
        runningFeed.controller = controllerRef;
      }
    }

    setImmediate(() => {
      void this.publishFeed(runningFeed, iterable);
    });
  }

  private async publishFeed(
    runningFeed: RunningFeed<Socket>,
    iterable: AsyncIterable<unknown>,
  ): Promise<void> {
    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        this.broadcastFeedChunk(runningFeed, {
          feed: runningFeed.key,
          type: "next",
          payload: chunk,
        });
      }

      this.broadcastFeedChunk(runningFeed, {
        feed: runningFeed.key,
        type: "done",
      });
    } catch (error) {
      this.broadcastFeedChunk(runningFeed, {
        feed: runningFeed.key,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningFeeds.delete(runningFeed.key);
      this.sharedControllers.delete(runningFeed.key);
    }
  }

  private broadcastFeedChunk(
    runningFeed: RunningFeed<Socket>,
    chunk: {
      feed: string;
      type: "next" | "done" | "error";
      payload?: unknown;
      message?: string;
    },
  ): void {
    for (const socket of runningFeed.subscribers) {
      if (!this.config.isSocketOpen(socket)) {
        continue;
      }

      this.config.onFeedChunk(socket, {
        channel: "feed",
        ...chunk,
      } satisfies ScompFeedChunkEnvelope);
    }
  }

  private replyWithPayload(
    socket: Socket,
    id: string | undefined,
    payload: unknown,
    meta?: ScompTransportMessageMeta,
  ): void {
    if (!id || !this.config.isSocketOpen(socket)) {
      return;
    }

    this.config.onReply(socket, {
      id,
      payload,
      meta,
    } satisfies ScompTransportResponseEnvelope);
  }

  private replyWithError(
    socket: Socket,
    id: string | undefined,
    error: unknown,
    meta?: ScompTransportMessageMeta,
    code?: ScompErrorCode,
  ): void {
    if (!id || !this.config.isSocketOpen(socket)) {
      return;
    }

    this.config.onReply(socket, {
      id,
      error: error instanceof Error ? error.message : String(error),
      code,
      meta,
    } satisfies ScompTransportResponseEnvelope);
  }

  private async checkSecurity(
    socket: Socket,
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<CheckSecurityResult> {
    const policy = this.config.security;
    if (!policy) {
      return {
        allowed: true,
        principal: this.config.getSocketPrincipal(socket),
      };
    }

    const rememberedPrincipal = this.config.getSocketPrincipal(socket);
    const principal = policy.authenticate
      ? await policy.authenticate(ctx)
      : rememberedPrincipal;

    if (principal) {
      this.config.setSocketPrincipal(socket, principal);
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
