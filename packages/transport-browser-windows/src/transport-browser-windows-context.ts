import type { ScompClientInvokeOptions } from "@scomp/core";
import type { ScompTransportMessageMeta } from "@scomp/types";
import type { ScompTransportOperation } from "@scomp/types";
import type {
  BrowserWindowsParticipantId,
  BrowserWindowsRequestId,
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";
import type {
  FeedQueueState,
  HostedFeedState,
  PendingRequestState,
  RuntimeRoute,
} from "./transport-browser-windows-state";

export interface BrowserWindowsHostContextInput {
  participantId: string;
  getRouter(): Record<string, RuntimeRoute>;
  hostedFeeds: Map<string, HostedFeedState>;
  postMessage(message: unknown): void;
  assertInboundAllowed(
    route: string,
    operation: "request" | "signal" | "feed_start" | "feed_stop",
    payload: unknown,
    meta: unknown,
  ): Promise<void>;
}

export function createHostContext(input: BrowserWindowsHostContextInput) {
  return {
    participantId: input.participantId,
    get router() {
      return input.getRouter();
    },
    hostedFeeds: input.hostedFeeds,
    postMessage: input.postMessage,
    assertInboundAllowed: input.assertInboundAllowed,
  };
}

export interface BrowserWindowsClientContextInput {
  participantId: BrowserWindowsParticipantId;
  requestTimeoutMs: number;
  maxPendingRequests: number;
  maxBufferedFeedChunksPerSubscriber: number;
  getPreparingRequests(): number;
  incrementPreparingRequests(): void;
  decrementPreparingRequests(): void;
  pendingRequests: Map<BrowserWindowsRequestId, PendingRequestState>;
  feedStates: Map<BrowserWindowsRequestId, FeedQueueState>;
  postMessage(message: unknown): void;
  reportHealth(
    code: BrowserWindowsTransportHealthReasonCode,
    detail: string | undefined,
    status: BrowserWindowsTransportHealthStatus,
  ): void;
  assertOutboundAllowed(route: string, operation: ScompTransportOperation): void;
  composeMetaForOperation(
    route: string,
    operation: "request" | "signal" | "feed_start" | "feed_stop",
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<{ meta: ScompTransportMessageMeta | undefined }>;
}

export function createClientContext(input: BrowserWindowsClientContextInput) {
  return {
    participantId: input.participantId,
    requestTimeoutMs: input.requestTimeoutMs,
    maxPendingRequests: input.maxPendingRequests,
    maxBufferedFeedChunksPerSubscriber: input.maxBufferedFeedChunksPerSubscriber,
    getPreparingRequests: input.getPreparingRequests,
    incrementPreparingRequests: input.incrementPreparingRequests,
    decrementPreparingRequests: input.decrementPreparingRequests,
    pendingRequests: input.pendingRequests,
    feedStates: input.feedStates,
    postMessage: input.postMessage,
    reportHealth: input.reportHealth,
    assertOutboundAllowed: input.assertOutboundAllowed,
    composeMetaForOperation: input.composeMetaForOperation,
  };
}

export interface BrowserWindowsTransportContextInput {
  participantId: BrowserWindowsParticipantId;
  requestTimeoutMs: number;
  maxPendingRequests: number;
  maxBufferedFeedChunksPerSubscriber: number;
  getRouter(): Record<string, RuntimeRoute>;
  getPreparingRequests(): number;
  incrementPreparingRequests(): void;
  decrementPreparingRequests(): void;
  pendingRequests: Map<BrowserWindowsRequestId, PendingRequestState>;
  feedStates: Map<BrowserWindowsRequestId, FeedQueueState>;
  hostedFeeds: Map<BrowserWindowsRequestId, HostedFeedState>;
  postMessage(message: unknown): void;
  reportHealth(
    code: BrowserWindowsTransportHealthReasonCode,
    detail: string | undefined,
    status: BrowserWindowsTransportHealthStatus,
  ): void;
  assertOutboundAllowed(route: string, operation: ScompTransportOperation): void;
  assertInboundAllowed(
    route: string,
    operation: "request" | "signal" | "feed_start" | "feed_stop",
    payload: unknown,
    meta: unknown,
  ): Promise<void>;
  composeMetaForOperation(
    route: string,
    operation: "request" | "signal" | "feed_start" | "feed_stop",
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<{ meta: ScompTransportMessageMeta | undefined }>;
}

export function createTransportContexts(input: BrowserWindowsTransportContextInput): {
  hostContext: ReturnType<typeof createHostContext>;
  clientContext: ReturnType<typeof createClientContext>;
} {
  return {
    hostContext: createHostContext({
      participantId: input.participantId,
      getRouter: input.getRouter,
      hostedFeeds: input.hostedFeeds,
      postMessage: input.postMessage,
      assertInboundAllowed: input.assertInboundAllowed,
    }),
    clientContext: createClientContext({
      participantId: input.participantId,
      requestTimeoutMs: input.requestTimeoutMs,
      maxPendingRequests: input.maxPendingRequests,
      maxBufferedFeedChunksPerSubscriber: input.maxBufferedFeedChunksPerSubscriber,
      getPreparingRequests: input.getPreparingRequests,
      incrementPreparingRequests: input.incrementPreparingRequests,
      decrementPreparingRequests: input.decrementPreparingRequests,
      pendingRequests: input.pendingRequests,
      feedStates: input.feedStates,
      postMessage: input.postMessage,
      reportHealth: input.reportHealth,
      assertOutboundAllowed: input.assertOutboundAllowed,
      composeMetaForOperation: input.composeMetaForOperation,
    }),
  };
}
