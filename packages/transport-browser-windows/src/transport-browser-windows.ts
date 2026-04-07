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
import {
  createParticipantId,
} from "./shared-worker-internal";
import {
  type BrowserWindowsParticipantId,
  type BrowserWindowsRequestId,
  type BrowserWindowsTransportConfig,
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
  handleInvokeFeedChunkMessage,
  handleInvokeResponseMessage,
  requestWithContext,
  signalWithContext,
} from "./transport-browser-windows-client";

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
    this.security = new BrowserWindowsTransportSecurity(config);
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
        this.connector.postMessage({
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

  async request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    return requestWithContext(this.clientContext(), route, payload, options);
  }

  async signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    await signalWithContext(this.clientContext(), route, payload, options);
  }

  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    return feedWithContext(this.clientContext(), route, payload, options);
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
    handleInvokeResponseMessage(this.pendingRequests, message);
  }

  private handleInvokeFeedChunk(message: BrowserWindowsInvokeFeedChunkMessage): void {
    handleInvokeFeedChunkMessage(
      this.feedStates,
      message,
      this.maxBufferedFeedChunksPerSubscriber,
      this.participantId,
      (payload) => this.connector.postMessage(payload),
    );
  }

  private async handleHostRequest(message: Parameters<typeof handleHostRequest>[1]): Promise<void> {
    await handleHostRequest(this.hostContext(), message);
  }

  private async handleHostSignal(message: Parameters<typeof handleHostSignal>[1]): Promise<void> {
    await handleHostSignal(this.hostContext(), message);
  }

  private async handleHostFeedStart(
    message: Parameters<typeof handleHostFeedStart>[1],
  ): Promise<void> {
    await handleHostFeedStart(this.hostContext(), message);
  }

  private handleHostFeedStop(message: BrowserWindowsHostFeedStopMessage): void {
    void handleHostFeedStop(this.hostContext(), message);
  }

  private hostContext() {
    return {
      participantId: this.participantId,
      router: this.router,
      hostedFeeds: this.hostedFeeds,
      postMessage: (message: unknown) => {
        this.connector.postMessage(message);
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
    };
  }

  private clientContext() {
    return {
      participantId: this.participantId,
      requestTimeoutMs: this.requestTimeoutMs,
      maxPendingRequests: this.maxPendingRequests,
      maxBufferedFeedChunksPerSubscriber: this.maxBufferedFeedChunksPerSubscriber,
      getPreparingRequests: () => this.preparingRequests,
      incrementPreparingRequests: () => {
        this.preparingRequests += 1;
      },
      decrementPreparingRequests: () => {
        this.preparingRequests -= 1;
      },
      pendingRequests: this.pendingRequests,
      feedStates: this.feedStates,
      postMessage: (message: unknown) => {
        this.connector.postMessage(message);
      },
      composeMetaForOperation: (
        route: string,
        operation: "request" | "signal" | "feed_start" | "feed_stop",
        payload: unknown,
        options?: ScompClientInvokeOptions,
      ) => {
        return this.composeMetaForOperation(route, operation, payload, options);
      },
    };
  }

  private async composeMetaForOperation(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ) {
    return this.security.composeMetaForOperation(route, operation, payload, options);
  }
}

export function createBrowserWindowsTransport(
  config: BrowserWindowsTransportConfig = {},
): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}
