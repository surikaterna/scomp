import {
  type CompiledRoute,
  createFeedHash,
  SCOMP_FRAMEWORK_PREFIX,
  SCOMP_SCOPE,
  ScompFrameworkMethods,
  type ScompHandlerContext,
} from "@scomp/core";
import type { ScompErrorCode, ScompFeedChunkEnvelope, ScompTransportMessageMeta } from "@scomp/types";
import {
  ensureFeedIterable,
  isControlledAsyncIterable,
  type RunningFeed,
  type RuntimeSocket,
  StreamClosedError,
  type TransportMessage,
  type WebSocketServerRuntimeConfig,
} from "./types";

export type {
  RuntimeSocket,
  TransportMessage,
  WebSocketServerRuntimeConfig,
} from "./types";
export { parseTransportMessage, StreamClosedError } from "./types";

type FeedChunkData = {
  feed: string;
  type: "next" | "done" | "error";
  payload?: unknown;
  message?: string;
};

export class WebSocketServerRuntime<Socket extends RuntimeSocket> {
  private router?: Record<string, CompiledRoute>;
  private readonly runningFeeds = new Map<string, RunningFeed<Socket>>();
  /** Shared controllers for fanout feeds, keyed by route+feedHash. */
  private readonly sharedControllers = new Map<string, Record<string, (payload: unknown) => unknown>>();

  constructor(private readonly config: WebSocketServerRuntimeConfig<Socket>) {}

  setRouter(router: Record<string, CompiledRoute>): void {
    this.router = router;
  }

  async handleIncoming(socket: Socket, body: TransportMessage): Promise<void> {
    const routeName = String(body.route ?? "");
    const routeEntry = this.router?.[routeName];
    const op = body.op ?? "request";

    if (!routeEntry) {
      this.replyWithError(socket, body.id, `Route not found: ${routeName}`, undefined, "ROUTE_NOT_FOUND");
      return;
    }

    const handlerCtx: ScompHandlerContext = {
      route: routeName,
      operation: op,
      meta: body.meta,
    };

    if (op === "signal" && body.method === ScompFrameworkMethods.UNSUBSCRIBE && body.feed) {
      this.handleFeedUnsubscribe(socket, body);
      return;
    }

    if (body.feed && body.method) {
      await this.handleControllerCall(socket, body);
      return;
    }

    if (routeEntry.kind === "feed") {
      await this.handleFeedRpc(socket, routeEntry, body, handlerCtx);
      return;
    }

    if (op === "signal" || routeEntry.kind === "signal") {
      try {
        await this.config.invokeRoute(routeEntry, body, handlerCtx);
      } catch {
        /* fire-and-forget */
      }
      return;
    }

    try {
      const result = await this.config.invokeRoute(routeEntry, body, handlerCtx);
      this.replyWithPayload(socket, body.id, result);
    } catch (error) {
      const code =
        (error as unknown as { code?: string })?.code === "UNAUTHORIZED"
          ? ("UNAUTHORIZED" as ScompErrorCode)
          : undefined;
      this.replyWithError(socket, body.id, error, undefined, code);
    }
  }

  detachSocketFromFeeds(socket: Socket): void {
    for (const runningFeed of this.runningFeeds.values()) {
      if (!runningFeed.subscribers.has(socket)) continue;
      runningFeed.subscribers.delete(socket);
      if (runningFeed.subscribers.size === 0) {
        runningFeed.abortController.abort(new StreamClosedError(runningFeed.key));
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

  private async handleControllerCall(socket: Socket, body: TransportMessage): Promise<void> {
    const feedId = String(body.feed ?? "");
    const method = String(body.method ?? "");

    const running = this.runningFeeds.get(feedId);
    if (!running) {
      this.replyWithError(socket, body.id, `Feed not found: ${feedId}`, undefined, "FEED_NOT_FOUND");
      return;
    }

    if (method.startsWith(SCOMP_FRAMEWORK_PREFIX)) {
      this.replyWithError(
        socket,
        body.id,
        `Framework method not implemented: ${method}`,
        undefined,
        "CONTROLLER_NOT_FOUND",
      );
      return;
    }

    const controller = running.controller;
    if (!controller || typeof controller[method] !== "function") {
      this.replyWithError(socket, body.id, `Controller method not found: ${method}`, undefined, "CONTROLLER_NOT_FOUND");
      return;
    }

    if ((body.op ?? "request") === "signal") {
      try {
        await controller[method](body.payload);
      } catch {
        /* fire-and-forget */
      }
      return;
    }

    try {
      const result = await controller[method](body.payload);
      this.replyWithPayload(socket, body.id, result);
    } catch (error) {
      this.replyWithError(socket, body.id, error);
    }
  }

  private async handleFeedRpc(
    socket: Socket,
    route: CompiledRoute,
    body: TransportMessage,
    ctx?: ScompHandlerContext,
  ): Promise<void> {
    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const hash = String(body.feed ?? createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }));

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

    const result = await this.config.invokeRoute(route, body, ctx);
    const iterable = ensureFeedIterable(result);

    if (isControlledAsyncIterable(result)) {
      const controllerRef = result.controller as Record<string, (payload: unknown) => unknown>;
      if (result[SCOMP_SCOPE] === "fanout") {
        const existing = this.sharedControllers.get(hash);
        runningFeed.controller = existing ?? controllerRef;
        if (!existing) this.sharedControllers.set(hash, controllerRef);
      } else {
        runningFeed.controller = controllerRef;
      }
    }

    setImmediate(() => {
      void this.publishFeed(runningFeed, iterable);
    });
  }

  private async publishFeed(runningFeed: RunningFeed<Socket>, iterable: AsyncIterable<unknown>): Promise<void> {
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

  private broadcastFeedChunk(runningFeed: RunningFeed<Socket>, chunk: FeedChunkData): void {
    for (const socket of runningFeed.subscribers) {
      if (!this.config.isSocketOpen(socket)) continue;
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
    if (!id || !this.config.isSocketOpen(socket)) return;
    this.config.onReply(socket, {
      id,
      payload,
      meta,
    } satisfies import("@scomp/types").ScompTransportResponseEnvelope);
  }

  private replyWithError(
    socket: Socket,
    id: string | undefined,
    error: unknown,
    meta?: ScompTransportMessageMeta,
    code?: ScompErrorCode,
  ): void {
    if (!id || !this.config.isSocketOpen(socket)) return;
    this.config.onReply(socket, {
      id,
      error: error instanceof Error ? error.message : String(error),
      code,
      meta,
    } satisfies import("@scomp/types").ScompTransportResponseEnvelope);
  }
}
