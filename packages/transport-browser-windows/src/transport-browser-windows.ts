import type { ITransport, ScompClientInvokeOptions } from "@scompr/core";
import type {
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsInvokeFeedChunkMessage,
  BrowserWindowsInvokeResponseMessage,
  BrowserWindowsProtocolMessage,
} from "./protocol";
import type { BrowserWindowsRuntimeEvent } from "./shared-worker-connector";
import { createRuntimeConnector } from "./shared-worker-connector";
import { createParticipantId, createRequestId } from "./shared-worker-internal";
import {
  feedWithContext,
  requestWithContext,
  requestWithContextUsingId,
  signalWithContext,
} from "./transport-browser-windows-client";
import { createTransportContexts } from "./transport-browser-windows-context";
import { dispatchIncomingMessage } from "./transport-browser-windows-dispatch";
import { createTransportHealthStore } from "./transport-browser-windows-health";
import { reportRuntimeHealthEvent, reportUnavailableConnectorError } from "./transport-browser-windows-health-events";
import {
  handleHostFeedStart,
  handleHostFeedStop,
  handleHostRequest,
  handleHostSignal,
} from "./transport-browser-windows-host";
import { processInvokeFeedChunk, processInvokeResponse } from "./transport-browser-windows-invoke";
import { sendHello, shutdownTransport, syncRoutes } from "./transport-browser-windows-lifecycle";
import { composeOutboundMeta } from "./transport-browser-windows-meta";
import { publishMessageWithHealth } from "./transport-browser-windows-publish";
import { assertStrictRouteIntentAllowed } from "./transport-browser-windows-route-intents";
import type {
  FeedQueueState,
  HostedFeedState,
  PendingRequestState,
  RuntimeRoute,
} from "./transport-browser-windows-state";
import type {
  BrowserWindowsParticipantId,
  BrowserWindowsRequestId,
  BrowserWindowsTransportConfig,
  BrowserWindowsTransportHealthListener,
  BrowserWindowsTransportHealthSnapshot,
  BrowserWindowsTransportMode,
} from "./types";

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
  private readonly pendingRequests = new Map<BrowserWindowsRequestId, PendingRequestState>();
  private preparingRequests = 0;
  private readonly feedStates = new Map<BrowserWindowsRequestId, FeedQueueState>();
  private readonly hostedFeeds = new Map<BrowserWindowsRequestId, HostedFeedState>();
  private readonly health: ReturnType<typeof createTransportHealthStore>;
  private activeRuntimeMode!: BrowserWindowsTransportMode;
  private readonly hostContext: ReturnType<typeof createTransportContexts>["hostContext"];
  private readonly clientContext: ReturnType<typeof createTransportContexts>["clientContext"];
  private router: Record<string, RuntimeRoute> = {};
  private readonly messageHandler = (data: unknown) => {
    this.handleIncoming(data as BrowserWindowsProtocolMessage);
  };
  private readonly runtimeEventHandler = (event: BrowserWindowsRuntimeEvent) => {
    if (event.type === "active-mode-changed") {
      this.activeRuntimeMode = event.mode;
      this.health.setActiveMode(event.mode);
      return;
    }

    reportRuntimeHealthEvent((code, detail, status) => {
      this.health.report(code, detail, status);
    }, event);
  };
  constructor(config: BrowserWindowsTransportConfig = {}) {
    this.config = config;
    this.requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? BrowserWindowsTransport.DEFAULT_REQUEST_TIMEOUT_MS);
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
    this.health = createTransportHealthStore(this.config.health?.onSnapshot);
    try {
      this.connector = createRuntimeConnector(this.config, this.participantId);
    } catch (error) {
      reportUnavailableConnectorError((code, detail, status) => {
        this.health.report(code, detail, status);
      }, error);
      throw error;
    }
    this.activeRuntimeMode = this.connector.activeMode;
    this.health.setActiveMode(this.activeRuntimeMode);
    this.connector.addMessageListener(this.messageHandler);
    this.connector.addRuntimeEventListener?.(this.runtimeEventHandler);
    const { hostContext, clientContext } = createTransportContexts({
      participantId: this.participantId,
      requestTimeoutMs: this.requestTimeoutMs,
      maxPendingRequests: this.maxPendingRequests,
      maxBufferedFeedChunksPerSubscriber: this.maxBufferedFeedChunksPerSubscriber,
      getRouter: () => this.router,
      getPreparingRequests: () => this.preparingRequests,
      incrementPreparingRequests: () => {
        this.preparingRequests += 1;
      },
      decrementPreparingRequests: () => {
        this.preparingRequests -= 1;
      },
      pendingRequests: this.pendingRequests,
      feedStates: this.feedStates,
      hostedFeeds: this.hostedFeeds,
      postMessage: (message: unknown) => {
        this.publishMessage(message);
      },
      reportHealth: (code, detail, status) => {
        this.health.report(code, detail, status);
      },
      assertOutboundAllowed: (route: string, operation: "request" | "signal" | "feed") => {
        this.assertOutboundAllowed(route, operation);
      },
      composeMetaForOperation: (
        _route: string,
        _operation: "request" | "signal" | "feed",
        _payload: unknown,
        options?: ScompClientInvokeOptions,
      ) => {
        return composeOutboundMeta(this.config.meta, options);
      },
    });
    this.hostContext = hostContext;
    this.clientContext = clientContext;
    sendHello(this.participantId, (message) => this.publishMessage(message));
  }

  registerRoutes(router: Record<string, unknown>): void {
    const previousRoutes = Object.keys(this.router);
    const nextRouter = router as Record<string, RuntimeRoute>;
    const nextRoutes = Object.keys(nextRouter);
    syncRoutes(this.participantId, previousRoutes, nextRoutes, (message) => this.publishMessage(message));
    this.router = nextRouter;
  }

  close(): void {
    shutdownTransport({
      participantId: this.participantId,
      routes: Object.keys(this.router),
      pendingRequests: this.pendingRequests,
      feedStates: this.feedStates,
      hostedFeeds: this.hostedFeeds,
      publishMessage: (message) => this.publishMessage(message),
      removeMessageListener: () => this.connector.removeMessageListener(this.messageHandler),
      removeRuntimeEventListener: () => this.connector.removeRuntimeEventListener?.(this.runtimeEventHandler),
      closeConnector: () => this.connector.close(),
    });
    this.router = {};
  }
  subscribeHealth(listener: BrowserWindowsTransportHealthListener): () => void {
    return this.health.subscribe(listener);
  }
  healthSnapshot(): BrowserWindowsTransportHealthSnapshot {
    return this.health.snapshot();
  }
  activeMode(): BrowserWindowsTransportMode {
    return this.activeRuntimeMode;
  }
  async request(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
    return requestWithContext(this.clientContext, route, payload, options);
  }
  async signal(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<void> {
    await signalWithContext(this.clientContext, route, payload, options);
  }
  feed(route: string, payload: unknown, options?: ScompClientInvokeOptions): AsyncIterable<unknown> {
    return feedWithContext(this.clientContext, route, payload, options);
  }
  async invoke(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
    const intents = this.config.routeIntents;
    let routeIntent: "request" | "signal" | "feed" | undefined;
    if (intents) {
      if (Array.isArray(intents)) {
        const entry = intents.find((i) => i.route === route);
        routeIntent = entry?.kind;
      } else {
        routeIntent = (intents as Record<string, "request" | "signal" | "feed">)[route];
      }
    }
    if (routeIntent === "signal") {
      await signalWithContext(this.clientContext, route, payload, options);
      return undefined;
    }
    if (routeIntent === "feed") {
      return feedWithContext(this.clientContext, route, payload, options);
    }
    if (routeIntent === "request") {
      return requestWithContext(this.clientContext, route, payload, options);
    }
    // No routeIntents: server-determines-behavior pattern
    return this.invokeServerDetermines(route, payload, options);
  }

  private async invokeServerDetermines(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    const requestId = createRequestId();

    // Pre-register feed state so chunks arriving are buffered
    const feedState: FeedQueueState = {
      queue: [],
      waiters: [],
      closed: false,
      stopSent: false,
      terminalError: undefined,
      route,
      payloadKey: "",
      payloadHash: "",
      meta: undefined,
    };
    this.feedStates.set(requestId, feedState);

    // Send as request and await response
    const result = await requestWithContextUsingId(this.clientContext, requestId, route, payload, options);

    // Check if host indicated this is a feed
    if (isFeedMarker(result)) {
      return createFeedIterableFromState(this, feedState, requestId, route, options);
    }

    // Normal request — clean up preemptive feed state
    this.feedStates.delete(requestId);
    return result;
  }
  private handleIncoming(message: BrowserWindowsProtocolMessage): void {
    dispatchIncomingMessage(this.participantId, message, {
      invokeResponse: (nextMessage) => {
        this.handleInvokeResponse(nextMessage);
      },
      invokeFeedChunk: (nextMessage) => {
        this.handleInvokeFeedChunk(nextMessage);
      },
      hostRequest: (nextMessage) => {
        void this.handleHostRequest(nextMessage);
      },
      hostSignal: (nextMessage) => {
        void this.handleHostSignal(nextMessage);
      },
      hostFeedStart: (nextMessage) => {
        void this.handleHostFeedStart(nextMessage);
      },
      hostFeedStop: (nextMessage) => {
        this.handleHostFeedStop(nextMessage);
      },
    });
  }
  private handleInvokeResponse(message: BrowserWindowsInvokeResponseMessage): void {
    processInvokeResponse(this.pendingRequests, message, (code, detail, status) => {
      this.health.report(code, detail, status);
    });
  }
  private handleInvokeFeedChunk(message: BrowserWindowsInvokeFeedChunkMessage): void {
    processInvokeFeedChunk(
      this.feedStates,
      message,
      this.maxBufferedFeedChunksPerSubscriber,
      this.participantId,
      (payload) => this.publishMessage(payload),
      (code, detail, status) => {
        this.health.report(code, detail, status);
      },
    );
  }

  private publishMessage(message: unknown): void {
    publishMessageWithHealth(
      (nextMessage) => this.connector.postMessage(nextMessage),
      (code, detail, status) => {
        this.health.report(code, detail, status);
      },
      message,
    );
  }
  private async handleHostRequest(message: Parameters<typeof handleHostRequest>[1]): Promise<void> {
    await handleHostRequest(this.hostContext, message);
  }
  private async handleHostSignal(message: Parameters<typeof handleHostSignal>[1]): Promise<void> {
    await handleHostSignal(this.hostContext, message);
  }
  private async handleHostFeedStart(message: Parameters<typeof handleHostFeedStart>[1]): Promise<void> {
    await handleHostFeedStart(this.hostContext, message);
  }

  private handleHostFeedStop(message: BrowserWindowsHostFeedStopMessage): void {
    void handleHostFeedStop(this.hostContext, message);
  }

  private assertOutboundAllowed(route: string, operation: "request" | "signal" | "feed"): void {
    assertStrictRouteIntentAllowed(this.config.strictRouteIntents === true, this.config.routeIntents, route, operation);
  }
}

export function createBrowserWindowsTransport(config: BrowserWindowsTransportConfig = {}): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}

function isFeedMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).__scomp_feed === true;
}

function createFeedIterableFromState(
  transport: BrowserWindowsTransport,
  state: FeedQueueState,
  requestId: string,
  route: string,
  _options?: ScompClientInvokeOptions,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        yield* drainFeedState(state);
      } finally {
        cleanupServerDeterminesFeed(transport, state, requestId, route);
      }
    },
  };
}

async function* drainFeedState(state: FeedQueueState): AsyncGenerator<unknown> {
  while (true) {
    if (state.queue.length > 0) {
      const nextValue = state.queue.shift();
      if (nextValue !== undefined) yield nextValue;
      if (state.closed && state.queue.length === 0) {
        if (state.terminalError) throw state.terminalError;
        return;
      }
      continue;
    }

    if (state.closed) {
      if (state.terminalError) throw state.terminalError;
      return;
    }

    await new Promise<void>((resolve) => {
      state.waiters.push(resolve);
    });
  }
}

function cleanupServerDeterminesFeed(
  transport: BrowserWindowsTransport,
  state: FeedQueueState,
  requestId: string,
  route: string,
): void {
  const t = transport as unknown as {
    feedStates: Map<string, unknown>;
    participantId: string;
    publishMessage(m: unknown): void;
  };
  t.feedStates.delete(requestId);
  if (!state.stopSent) {
    state.stopSent = true;
    t.publishMessage({
      type: "invoke_feed_stop",
      sourceId: t.participantId,
      sentAtMs: Date.now(),
      requestId,
      route,
      operation: "signal",
      method: "__scomp.unsubscribe",
      payloadKey: "",
      payloadHash: "",
    });
  }
}
