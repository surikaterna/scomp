import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";
import type {
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsInvokeFeedChunkMessage,
  BrowserWindowsInvokeResponseMessage,
  BrowserWindowsProtocolMessage,
} from "./protocol";
import { createRuntimeConnector } from "./shared-worker-connector";
import { createParticipantId } from "./shared-worker-internal";
import {
  type BrowserWindowsParticipantId,
  type BrowserWindowsRequestId,
  type BrowserWindowsTransportConfig,
  type BrowserWindowsTransportHealthListener,
  type BrowserWindowsTransportHealthSnapshot,
  type BrowserWindowsTransportMode,
} from "./types";
import {
  type HostedFeedState,
  type FeedQueueState,
  type PendingRequestState,
  type RuntimeRoute,
} from "./transport-browser-windows-state";
import {
  handleHostFeedStart,
  handleHostFeedStop,
  handleHostRequest,
  handleHostSignal,
} from "./transport-browser-windows-host";
import {
  feedWithContext,
  requestWithContext,
  signalWithContext,
} from "./transport-browser-windows-client";
import { createTransportHealthStore } from "./transport-browser-windows-health";
import type { BrowserWindowsRuntimeEvent } from "./shared-worker-connector";
import { createTransportContexts } from "./transport-browser-windows-context";
import { dispatchIncomingMessage } from "./transport-browser-windows-dispatch";
import {
  reportRuntimeHealthEvent,
  reportUnavailableConnectorError,
} from "./transport-browser-windows-health-events";
import {
  processInvokeFeedChunk,
  processInvokeResponse,
} from "./transport-browser-windows-invoke";
import { publishMessageWithHealth } from "./transport-browser-windows-publish";
import { composeOutboundMeta } from "./transport-browser-windows-meta";
import {
  sendHello,
  shutdownTransport,
  syncRoutes,
} from "./transport-browser-windows-lifecycle";
import { assertStrictRouteIntentAllowed } from "./transport-browser-windows-route-intents";

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
  private readonly feedStates = new Map<
    BrowserWindowsRequestId,
    FeedQueueState
  >();
  private readonly hostedFeeds = new Map<
    BrowserWindowsRequestId,
    HostedFeedState
  >();
  private readonly health: ReturnType<typeof createTransportHealthStore>;
  private activeRuntimeMode!: BrowserWindowsTransportMode;
  private readonly hostContext: ReturnType<
    typeof createTransportContexts
  >["hostContext"];
  private readonly clientContext: ReturnType<
    typeof createTransportContexts
  >["clientContext"];
  private router: Record<string, RuntimeRoute> = {};
  private readonly messageHandler = (data: unknown) => {
    this.handleIncoming(data as BrowserWindowsProtocolMessage);
  };
  private readonly runtimeEventHandler = (
    event: BrowserWindowsRuntimeEvent,
  ) => {
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
    this.requestTimeoutMs = Math.max(
      1,
      config.requestTimeoutMs ??
        BrowserWindowsTransport.DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.maxPendingRequests = Math.max(
      1,
      config.maxPendingRequests ??
        BrowserWindowsTransport.DEFAULT_MAX_PENDING_REQUESTS,
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
      maxBufferedFeedChunksPerSubscriber:
        this.maxBufferedFeedChunksPerSubscriber,
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
      assertOutboundAllowed: (
        route: string,
        operation: "request" | "signal" | "feed",
      ) => {
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
    syncRoutes(this.participantId, previousRoutes, nextRoutes, (message) =>
      this.publishMessage(message),
    );
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
      removeMessageListener: () =>
        this.connector.removeMessageListener(this.messageHandler),
      removeRuntimeEventListener: () =>
        this.connector.removeRuntimeEventListener?.(this.runtimeEventHandler),
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
  async request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    return requestWithContext(this.clientContext, route, payload, options);
  }
  async signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    await signalWithContext(this.clientContext, route, payload, options);
  }
  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    return feedWithContext(this.clientContext, route, payload, options);
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
  private handleInvokeResponse(
    message: BrowserWindowsInvokeResponseMessage,
  ): void {
    processInvokeResponse(
      this.pendingRequests,
      message,
      (code, detail, status) => {
        this.health.report(code, detail, status);
      },
    );
  }
  private handleInvokeFeedChunk(
    message: BrowserWindowsInvokeFeedChunkMessage,
  ): void {
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
  private async handleHostRequest(
    message: Parameters<typeof handleHostRequest>[1],
  ): Promise<void> {
    await handleHostRequest(this.hostContext, message);
  }
  private async handleHostSignal(
    message: Parameters<typeof handleHostSignal>[1],
  ): Promise<void> {
    await handleHostSignal(this.hostContext, message);
  }
  private async handleHostFeedStart(
    message: Parameters<typeof handleHostFeedStart>[1],
  ): Promise<void> {
    await handleHostFeedStart(this.hostContext, message);
  }

  private handleHostFeedStop(message: BrowserWindowsHostFeedStopMessage): void {
    void handleHostFeedStop(this.hostContext, message);
  }

  private assertOutboundAllowed(
    route: string,
    operation: "request" | "signal" | "feed",
  ): void {
    assertStrictRouteIntentAllowed(
      this.config.strictRouteIntents === true,
      this.config.routeIntents,
      route,
      operation,
    );
  }
}

export function createBrowserWindowsTransport(
  config: BrowserWindowsTransportConfig = {},
): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}
