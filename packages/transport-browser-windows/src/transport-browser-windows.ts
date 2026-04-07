import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompTransportOperation,
  ScompTransportMessageMeta,
} from "@scomp/types";
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
} from "./types";
import {
  type HostedFeedState,
  type FeedQueueState,
  type PendingRequestState,
  type RuntimeRoute,
  rejectPendingRequest,
} from "./transport-browser-windows-state";
import {
  handleHostFeedStart,
  handleHostFeedStop,
  handleHostRequest,
  handleHostSignal,
} from "./transport-browser-windows-host";
import { BrowserWindowsTransportSecurity } from "./transport-browser-windows-security";
import {
  feedWithContext,
  requestWithContext,
  signalWithContext,
} from "./transport-browser-windows-client";
import { createTransportHealthStore } from "./transport-browser-windows-health";
import type { BrowserWindowsRuntimeEvent } from "./shared-worker-connector";
import { createTransportContexts } from "./transport-browser-windows-context";
import { dispatchIncomingMessage } from "./transport-browser-windows-dispatch";
import { reportAuthDeniedError, reportRuntimeHealthEvent } from "./transport-browser-windows-health-events";
import { processInvokeFeedChunk, processInvokeResponse } from "./transport-browser-windows-invoke";
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
  private readonly security: BrowserWindowsTransportSecurity;
  private readonly health = createTransportHealthStore();
  private readonly hostContext: ReturnType<typeof createTransportContexts>["hostContext"];
  private readonly clientContext: ReturnType<typeof createTransportContexts>["clientContext"];
  private router: Record<string, RuntimeRoute> = {};
  private readonly messageHandler = (data: unknown) => {
    this.handleIncoming(data as BrowserWindowsProtocolMessage);
  };
  private readonly runtimeEventHandler = (event: BrowserWindowsRuntimeEvent) => {
    reportRuntimeHealthEvent((code, detail, status) => {
      this.health.report(code, detail, status);
    }, event);
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
    this.security = new BrowserWindowsTransportSecurity(config);
    this.connector = createRuntimeConnector(this.config, this.participantId);
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
      assertInboundAllowed: (
        route: string,
        operation: "request" | "signal" | "feed_start" | "feed_stop",
        payload: unknown,
        meta: unknown,
      ) => {
        return this.security.assertInboundAllowed(
          route,
          operation,
          payload,
          meta as ScompTransportMessageMeta | undefined,
        );
      },
      composeMetaForOperation: (
        route: string,
        operation: "request" | "signal" | "feed_start" | "feed_stop",
        payload: unknown,
        options?: ScompClientInvokeOptions,
      ) => {
        return this.composeMetaForOperation(route, operation, payload, options);
      },
    });
    this.hostContext = hostContext;
    this.clientContext = clientContext;
    if (this.config.health?.onSnapshot) {
      this.subscribeHealth(this.config.health.onSnapshot);
    }
    this.publishMessage({
      type: "hello",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
    });
  }
  listen(router: Record<string, unknown>): void {
    const previousRoutes = Object.keys(this.router);
    if (previousRoutes.length > 0) {
      this.publishMessage({
        type: "routes_unregister",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        routes: previousRoutes,
      });
    }

    this.router = router as Record<string, RuntimeRoute>;
    const nextRoutes = Object.keys(this.router);
    if (nextRoutes.length > 0) {
      this.publishMessage({
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
      this.publishMessage({
        type: "routes_unregister",
        sourceId: this.participantId,
        sentAtMs: Date.now(),
        routes,
      });
    }

    this.router = {};

    this.publishMessage({
      type: "participant_disconnect",
      sourceId: this.participantId,
      sentAtMs: Date.now(),
    });

    this.connector.removeMessageListener(this.messageHandler);
    this.connector.removeRuntimeEventListener?.(this.runtimeEventHandler);

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      rejectPendingRequest(
        requestId,
        pending,
        new Error("BrowserWindowsTransport closed."),
      );
    }
    this.pendingRequests.clear();

    for (const [requestId, feed] of this.feedStates.entries()) {
      feed.closed = true;
      feed.terminalError = new Error("BrowserWindowsTransport closed.");
      feed.queue.length = 0;
      while (feed.waiters.length > 0) {
        feed.waiters.shift()?.();
      }
      if (!feed.stopSent) {
        this.publishMessage({
          type: "invoke_feed_stop",
          sourceId: this.participantId,
          sentAtMs: Date.now(),
          requestId,
          route: feed.route,
          operation: "feed_stop",
          payloadKey: feed.payloadKey,
          payloadHash: feed.payloadHash,
        });
        feed.stopSent = true;
      }
    }
    this.feedStates.clear();

    for (const hostedFeed of this.hostedFeeds.values()) {
      hostedFeed.stopped = true;
      hostedFeed.unsubscribe?.();
    }
    this.hostedFeeds.clear();
    this.connector.close();
  }
  subscribeHealth(listener: BrowserWindowsTransportHealthListener): () => void {
    return this.health.subscribe(listener);
  }
  healthSnapshot(): BrowserWindowsTransportHealthSnapshot {
    return this.health.snapshot();
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
    try {
      this.connector.postMessage(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.health.report("publish-failed", detail, "unavailable");
    }
  }
  private async handleHostRequest(message: Parameters<typeof handleHostRequest>[1]): Promise<void> {
    await handleHostRequest(this.hostContext, message);
  }
  private async handleHostSignal(message: Parameters<typeof handleHostSignal>[1]): Promise<void> {
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
  private async composeMetaForOperation(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ) {
    try {
      return await this.security.composeMetaForOperation(route, operation, payload, options);
    } catch (error) {
      reportAuthDeniedError((code, detail, status) => {
        this.health.report(code, detail, status);
      }, error);
      throw error;
    }
  }
}

export function createBrowserWindowsTransport(
  config: BrowserWindowsTransportConfig = {},
): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}
