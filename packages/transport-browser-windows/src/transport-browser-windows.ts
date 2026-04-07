import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompTransportMessageMeta,
  ScompTransportOperation,
  ScompTransportPrincipal,
  ScompTransportSecurityContext,
} from "@scomp/types";
import type {
  BrowserWindowsHostFeedStartMessage,
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsHostRequestMessage,
  BrowserWindowsHostSignalMessage,
  BrowserWindowsInvokeFeedChunkMessage,
  BrowserWindowsInvokeResponseMessage,
  BrowserWindowsProtocolMessage,
} from "./protocol";
import { createRuntimeConnector } from "./shared-worker-connector";
import {
  createParticipantId,
  createPayloadHash,
  createPayloadKey,
  createRequestId,
  mergeMeta,
  toPrincipalMeta,
  toPriorityMeta,
} from "./shared-worker-internal";
import type {
  BrowserWindowsParticipantId,
  BrowserWindowsRequestId,
  BrowserWindowsTransportConfig,
} from "./types";

interface PendingRequestState {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface FeedQueueState {
  queue: Array<unknown>;
  waiters: Array<() => void>;
  closed: boolean;
  stopSent: boolean;
  terminalError?: Error;
  route: string;
  payloadKey: string;
  payloadHash: string;
}

interface HostedFeedState {
  stopped: boolean;
  unsubscribe?: () => void;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallback);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.iterator in value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

function toAsyncIterable(value: unknown): AsyncIterable<unknown> {
  if (isAsyncIterable(value)) {
    return value;
  }

  if (isIterable(value)) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const nextValue of value) {
          yield nextValue;
        }
      },
    };
  }

  throw new Error("Feed handler did not return an iterable value.");
}

function routeOperation(route: unknown): "request" | "signal" | "feed" {
  const routeRecord = route as { kind?: string };
  if (routeRecord?.kind === "signal") {
    return "signal";
  }

  if (routeRecord?.kind === "feed") {
    return "feed";
  }

  return "request";
}

interface RuntimeRoute {
  parser?: (payload: unknown) => unknown;
  handler: (payload: unknown) => unknown;
  kind?: "request" | "signal" | "feed";
  hashKey?: (payload: unknown) => string;
}

export class BrowserWindowsTransport implements ITransport {
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  private static readonly DEFAULT_MAX_PENDING_REQUESTS = 1_000;
  private static readonly DEFAULT_MAX_BUFFERED_FEED_CHUNKS_PER_SUBSCRIBER = 256;

  private readonly config: BrowserWindowsTransportConfig;
  private readonly participantId: BrowserWindowsParticipantId;
  private readonly connector: ReturnType<typeof createRuntimeConnector>;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxBufferedFeedChunksPerSubscriber: number;
  private readonly pendingRequests = new Map<
    BrowserWindowsRequestId,
    PendingRequestState
  >();
  private preparingRequests = 0;
  private readonly feedStates = new Map<BrowserWindowsRequestId, FeedQueueState>();
  private readonly hostedFeeds = new Map<BrowserWindowsRequestId, HostedFeedState>();
  private router: Record<string, RuntimeRoute> = {};
  private readonly messageHandler = (data: unknown) => {
    this.handleIncoming(data as BrowserWindowsProtocolMessage);
  };

  constructor(config: BrowserWindowsTransportConfig = {}) {
    this.config = config;
    this.requestTimeoutMs = Math.max(
      1,
      config.requestTimeoutMs ?? BrowserWindowsTransport.DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.maxPendingRequests = Math.max(
      1,
      config.maxPendingRequests ?? BrowserWindowsTransport.DEFAULT_MAX_PENDING_REQUESTS,
    );
    this.maxBufferedFeedChunksPerSubscriber = Math.max(
      1,
      config.maxBufferedFeedChunksPerSubscriber ??
        BrowserWindowsTransport.DEFAULT_MAX_BUFFERED_FEED_CHUNKS_PER_SUBSCRIBER,
    );
    this.participantId = createParticipantId(this.config);
    this.connector = createRuntimeConnector(this.config, this.participantId);
    this.connector.addMessageListener(this.messageHandler);
    this.connector.postMessage({
      type: "hello",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
    });
  }

  listen(router: Record<string, unknown>): void {
    const previousRoutes = Object.keys(this.router);
    if (previousRoutes.length > 0) {
      this.connector.postMessage({
        type: "routes_unregister",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        routes: previousRoutes,
      });
    }

    this.router = router as Record<string, RuntimeRoute>;
    const nextRoutes = Object.keys(this.router);
    if (nextRoutes.length > 0) {
      this.connector.postMessage({
        type: "routes_register",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        routes: nextRoutes,
      });
    }
  }

  close(): void {
    const routes = Object.keys(this.router);
    if (routes.length > 0) {
      this.connector.postMessage({
        type: "routes_unregister",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        routes,
      });
    }

    this.router = {};

    this.connector.postMessage({
      type: "participant_disconnect",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
    });

    this.connector.removeMessageListener(this.messageHandler);

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.rejectPendingRequest(requestId, pending, new Error("BrowserWindowsTransport closed."));
    }
    this.pendingRequests.clear();

    for (const [requestId, feed] of this.feedStates.entries()) {
      this.terminateFeedState(
        requestId,
        feed,
        new Error("BrowserWindowsTransport closed."),
        true,
      );
    }
    this.feedStates.clear();

    for (const hostedFeed of this.hostedFeeds.values()) {
      hostedFeed.stopped = true;
      hostedFeed.unsubscribe?.();
    }
    this.hostedFeeds.clear();
    this.connector.close();
  }

  async request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    if (this.pendingRequests.size + this.preparingRequests >= this.maxPendingRequests) {
      throw new Error(
        `BrowserWindowsTransport max pending requests exceeded (${this.maxPendingRequests}).`,
      );
    }

    const requestId = createRequestId();
    this.preparingRequests += 1;
    let meta: ScompTransportMessageMeta | undefined;
    try {
      meta = (await this.composeMetaForOperation(route, "request", payload, options)).meta;
    } finally {
      this.preparingRequests -= 1;
    }

    const response = new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(requestId);
        this.rejectPendingRequest(
          requestId,
          pending,
          new Error(
            `BrowserWindowsTransport request timed out after ${this.requestTimeoutMs}ms for route ${route}.`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });

    this.connector.postMessage({
      type: "invoke_request",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
      requestId,
      route,
      operation: "request",
      payload,
      meta,
    });

    return response;
  }

  async signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const { meta } = await this.composeMetaForOperation(route, "signal", payload, options);

    this.connector.postMessage({
      type: "invoke_signal",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
      requestId: createRequestId(),
      route,
      operation: "signal",
      payload,
      meta,
    });
  }

  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    const requestId = createRequestId();
    const payloadKey = createPayloadKey(payload);
    const payloadHash = createPayloadHash(route, payload);

    return {
      [Symbol.asyncIterator]: async function* (this: BrowserWindowsTransport) {
        const state: FeedQueueState = {
          queue: [],
          waiters: [],
          closed: false,
          stopSent: false,
          terminalError: undefined,
          route,
          payloadKey,
          payloadHash,
        };
        this.feedStates.set(requestId, state);

        let feedStarted = false;

        try {
          this.connector.postMessage({
            meta: (
              await this.composeMetaForOperation(route, "feed_start", payload, options)
            ).meta,
            type: "invoke_feed_start",
            sourceId: this.participantId,
            sentAtMs: Date.now(),
            requestId,
            route,
            operation: "feed_start",
            payload,
            payloadKey,
            payloadHash,
          });
          feedStarted = true;

          while (true) {
            if (state.queue.length > 0) {
              const nextValue = state.queue.shift();
              if (nextValue !== undefined) {
                yield nextValue;
              }

              if (state.closed && state.queue.length === 0) {
                if (state.terminalError) {
                  throw state.terminalError;
                }
                return;
              }

              continue;
            }

            if (state.closed) {
              if (state.terminalError) {
                throw state.terminalError;
              }
              return;
            }

            await new Promise<void>((resolve) => {
              state.waiters.push(resolve);
            });
          }
        } finally {
          this.feedStates.delete(requestId);
          if (feedStarted && !state.stopSent) {
            this.connector.postMessage({
              meta: (
                await this.composeMetaForOperation(
                  route,
                  "feed_stop",
                  { payloadKey: state.payloadKey, payloadHash: state.payloadHash },
                  options,
                )
              ).meta,
              type: "invoke_feed_stop",
              sourceId: this.participantId,
              sentAtMs: Date.now(),
              requestId,
              route,
              operation: "feed_stop",
              payloadKey: state.payloadKey,
              payloadHash: state.payloadHash,
            });
            state.stopSent = true;
          }
        }
      }.bind(this),
    };
  }

  private handleIncoming(message: BrowserWindowsProtocolMessage): void {
    if (message.targetId && message.targetId !== this.participantId) {
      return;
    }

    switch (message.type) {
      case "invoke_response":
        this.handleInvokeResponse(message);
        return;
      case "invoke_feed_chunk":
        this.handleInvokeFeedChunk(message);
        return;
      case "host_request":
        void this.handleHostRequest(message);
        return;
      case "host_signal":
        void this.handleHostSignal(message);
        return;
      case "host_feed_start":
        void this.handleHostFeedStart(message);
        return;
      case "host_feed_stop":
        this.handleHostFeedStop(message);
        return;
      case "hello":
      case "hello_ack":
      case "participant_disconnect":
      case "heartbeat":
      case "routes_register":
      case "routes_unregister":
      case "invoke_request":
      case "invoke_signal":
      case "invoke_feed_start":
      case "invoke_feed_stop":
      case "host_response":
      case "host_feed_started":
      case "host_feed_chunk":
        return;
      default:
        return;
    }
  }

  private handleInvokeResponse(message: BrowserWindowsInvokeResponseMessage): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.requestId);
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.payload);
  }

  private handleInvokeFeedChunk(
    message: BrowserWindowsInvokeFeedChunkMessage,
  ): void {
    const state = this.feedStates.get(message.requestId);
    if (!state) {
      return;
    }

    if (message.chunkType === "next") {
      if (state.queue.length >= this.maxBufferedFeedChunksPerSubscriber) {
        this.terminateFeedState(
          message.requestId,
          state,
          new Error(
            `BrowserWindowsTransport feed buffer exceeded ${this.maxBufferedFeedChunksPerSubscriber} chunks for route ${state.route}.`,
          ),
          true,
        );
        return;
      }

      state.queue.push(message.payload);
    } else if (message.chunkType === "error") {
      this.terminateFeedState(
        message.requestId,
        state,
        new Error(message.message ?? "Feed error."),
        false,
      );
      return;
    } else {
      this.terminateFeedState(message.requestId, state, undefined, false);
      return;
    }

    while (state.waiters.length > 0) {
      state.waiters.shift()?.();
    }
  }

  private async handleHostRequest(
    message: BrowserWindowsHostRequestMessage,
  ): Promise<void> {
    const route = this.router[message.route];
    if (!route) {
      this.connector.postMessage({
        type: "host_response",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        error: `No route handler registered for ${message.route}`,
        meta: message.meta,
      });
      return;
    }

    if (routeOperation(route) !== "request") {
      this.connector.postMessage({
        type: "host_response",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        error: `Route ${message.route} does not support request operation`,
        meta: message.meta,
      });
      return;
    }

    try {
      await this.assertInboundAllowed(
        message.route,
        "request",
        message.payload,
        message.meta,
      );

      const parsedPayload = route.parser
        ? route.parser(message.payload)
        : message.payload;
      const response = await route.handler(parsedPayload);
      this.connector.postMessage({
        type: "host_response",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payload: response,
        meta: message.meta,
      });
    } catch (error) {
      this.connector.postMessage({
        type: "host_response",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        error: toError(error, "Request failed.").message,
        meta: message.meta,
      });
    }
  }

  private async handleHostSignal(
    message: BrowserWindowsHostSignalMessage,
  ): Promise<void> {
    const route = this.router[message.route];
    if (!route) {
      return;
    }

    if (routeOperation(route) !== "signal") {
      return;
    }

    try {
      await this.assertInboundAllowed(
        message.route,
        "signal",
        message.payload,
        message.meta,
      );

      const parsedPayload = route.parser
        ? route.parser(message.payload)
        : message.payload;
      await route.handler(parsedPayload);
    } catch {
      // signal has no response path
    }
  }

  private async handleHostFeedStart(
    message: BrowserWindowsHostFeedStartMessage,
  ): Promise<void> {
    const route = this.router[message.route];
    if (!route) {
      this.connector.postMessage({
        type: "host_feed_chunk",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        chunkType: "error",
        message: `No feed handler registered for ${message.route}`,
        meta: message.meta,
      });
      return;
    }

    if (routeOperation(route) !== "feed") {
      this.connector.postMessage({
        type: "host_feed_chunk",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        chunkType: "error",
        message: `Route ${message.route} does not support feed operation`,
        meta: message.meta,
      });
      return;
    }

    try {
      await this.assertInboundAllowed(
        message.route,
        "feed_start",
        message.payload,
        message.meta,
      );

      const parsedPayload = route.parser
        ? route.parser(message.payload)
        : message.payload;

      const produced = route.handler(parsedPayload);
      const asyncIterable = toAsyncIterable(produced);
      const hostedState: HostedFeedState = { stopped: false };

      if (
        typeof produced === "object" &&
        produced !== null &&
        "unsubscribe" in produced &&
        typeof (produced as { unsubscribe?: () => void }).unsubscribe === "function"
      ) {
        hostedState.unsubscribe = () => {
          (produced as { unsubscribe: () => void }).unsubscribe();
        };
      }

      this.hostedFeeds.set(message.requestId, hostedState);

      this.connector.postMessage({
        type: "host_feed_started",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        meta: message.meta,
      });

      for await (const chunk of asyncIterable) {
        if (hostedState.stopped) {
          break;
        }

        this.connector.postMessage({
          type: "host_feed_chunk",
          sourceId: this.participantId,
          sentAtMs: Date.now(),
          requestId: message.requestId,
          invokeId: message.invokeId,
          hostId: this.participantId,
          payloadKey: message.payloadKey,
          payloadHash: message.payloadHash,
          chunkType: "next",
          payload: chunk,
          meta: message.meta,
        });
      }

      this.connector.postMessage({
        type: "host_feed_chunk",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        chunkType: "done",
        meta: message.meta,
      });
    } catch (error) {
      this.connector.postMessage({
        type: "host_feed_chunk",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: this.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        chunkType: "error",
        message: toError(error, "Feed failed.").message,
        meta: message.meta,
      });
    } finally {
      this.hostedFeeds.delete(message.requestId);
    }
  }

  private handleHostFeedStop(message: BrowserWindowsHostFeedStopMessage): void {
    void this.handleHostFeedStopAsync(message);
  }

  private async resolveConfigMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const { meta } = this.config;
    if (!meta) {
      return undefined;
    }

    if (typeof meta === "function") {
      return meta();
    }

    return meta;
  }

  /**
   * Deterministic outbound meta precedence (websocket-browser parity):
   * config.meta -> options.meta -> priority hints -> principal-derived auth context.
   */
  private async composeMetaForOperation(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<{
    meta: ScompTransportMessageMeta | undefined;
    principal: ScompTransportPrincipal | undefined;
  }> {
    const configMeta = await this.resolveConfigMeta();
    const optionsMeta = options?.meta;
    const priorityMeta = toPriorityMeta(options);
    const effectiveMeta = mergeMeta(mergeMeta(configMeta, optionsMeta), priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
      direction: "outbound",
      transport: "browser-windows",
      route,
      operation,
      payload,
      meta: effectiveMeta,
    });

    if (!allowed) {
      throw new Error(`${operation} not authorized for route: ${route}`);
    }

    return {
      meta: mergeMeta(effectiveMeta, toPrincipalMeta(principal)),
      principal,
    };
  }

  private async assertInboundAllowed(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    meta: ScompTransportMessageMeta | undefined,
  ): Promise<void> {
    const { allowed } = await this.checkSecurity({
      direction: "inbound",
      transport: "browser-windows",
      route,
      operation,
      payload,
      meta,
    });

    if (!allowed) {
      throw new Error(`${operation} not authorized for route: ${route}`);
    }
  }

  private async handleHostFeedStopAsync(
    message: BrowserWindowsHostFeedStopMessage,
  ): Promise<void> {
    const hosted = this.hostedFeeds.get(message.requestId);
    if (!hosted) {
      return;
    }

    try {
      await this.assertInboundAllowed(
        message.route,
        "feed_stop",
        { payloadKey: message.payloadKey, payloadHash: message.payloadHash },
        message.meta,
      );
    } catch {
      return;
    }

    hosted.stopped = true;
    hosted.unsubscribe?.();
    this.hostedFeeds.delete(message.requestId);
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

  private rejectPendingRequest(
    _requestId: BrowserWindowsRequestId,
    pending: PendingRequestState,
    error: Error,
  ): void {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    pending.reject(error);
  }

  private terminateFeedState(
    requestId: BrowserWindowsRequestId,
    state: FeedQueueState,
    error: Error | undefined,
    shouldNotifyStop: boolean,
  ): void {
    if (state.closed) {
      return;
    }

    state.closed = true;
    state.terminalError = error;
    state.queue.length = 0;

    while (state.waiters.length > 0) {
      state.waiters.shift()?.();
    }

    if (shouldNotifyStop) {
      if (state.stopSent) {
        return;
      }

      this.connector.postMessage({
        type: "invoke_feed_stop",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        requestId,
        route: state.route,
        operation: "feed_stop",
        payloadKey: state.payloadKey,
        payloadHash: state.payloadHash,
      });
      state.stopSent = true;
    }
  }
}

export function createBrowserWindowsTransport(
  config: BrowserWindowsTransportConfig = {},
): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}
