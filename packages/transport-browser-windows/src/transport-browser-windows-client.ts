import type { ScompClientInvokeOptions } from "@scompr/core";
import type { ScompTransportMessageMeta } from "@scompr/types";
import type { BrowserWindowsInvokeFeedChunkMessage, BrowserWindowsInvokeResponseMessage } from "./protocol";
import { createPayloadHash, createPayloadKey, createRequestId } from "./shared-worker-internal";
import {
  type FeedQueueState,
  type PendingRequestState,
  rejectPendingRequest,
  terminateFeedState,
} from "./transport-browser-windows-state";
import type {
  BrowserWindowsRequestId,
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";

export interface BrowserWindowsTransportClientContext {
  participantId: string;
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
  assertOutboundAllowed(route: string, operation: "request" | "signal" | "feed"): void;
  composeMetaForOperation(
    route: string,
    operation: "request" | "signal" | "feed",
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<ScompTransportMessageMeta | undefined>;
}

export async function requestWithContext(
  context: BrowserWindowsTransportClientContext,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<unknown> {
  return requestWithContextUsingId(context, createRequestId(), route, payload, options);
}

export async function requestWithContextUsingId(
  context: BrowserWindowsTransportClientContext,
  requestId: string,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<unknown> {
  if (context.pendingRequests.size + context.getPreparingRequests() >= context.maxPendingRequests) {
    throw new Error(`BrowserWindowsTransport max pending requests exceeded (${context.maxPendingRequests}).`);
  }

  context.incrementPreparingRequests();
  let meta: ScompTransportMessageMeta | undefined;
  try {
    context.assertOutboundAllowed(route, "request");
    meta = await context.composeMetaForOperation(route, "request", payload, options);
  } finally {
    context.decrementPreparingRequests();
  }

  const response = new Promise<unknown>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const pending = context.pendingRequests.get(requestId as BrowserWindowsRequestId);
      if (!pending) {
        return;
      }

      context.pendingRequests.delete(requestId as BrowserWindowsRequestId);
      context.reportHealth("request-timeout", `Request timed out for route: ${route}`, "degraded");
      rejectPendingRequest(
        requestId as BrowserWindowsRequestId,
        pending,
        new Error(`BrowserWindowsTransport request timed out after ${context.requestTimeoutMs}ms for route ${route}.`),
      );
    }, context.requestTimeoutMs);

    context.pendingRequests.set(requestId as BrowserWindowsRequestId, { resolve, reject, timeoutId });
  });

  context.postMessage({
    type: "invoke_request",
    sourceId: context.participantId,
    sentAtMs: Date.now(),
    requestId,
    route,
    operation: "request",
    payload,
    meta,
  });

  return response;
}

export async function signalWithContext(
  context: BrowserWindowsTransportClientContext,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<void> {
  context.assertOutboundAllowed(route, "signal");
  const meta = await context.composeMetaForOperation(route, "signal", payload, options);

  context.postMessage({
    type: "invoke_signal",
    sourceId: context.participantId,
    sentAtMs: Date.now(),
    requestId: createRequestId(),
    route,
    operation: "signal",
    payload,
    meta,
  });
}

function initFeedState(route: string, payloadKey: string, payloadHash: string): FeedQueueState {
  return {
    queue: [],
    waiters: [],
    closed: false,
    stopSent: false,
    terminalError: undefined,
    route,
    payloadKey,
    payloadHash,
    meta: undefined,
  };
}

async function startFeed(
  context: BrowserWindowsTransportClientContext,
  state: FeedQueueState,
  requestId: string,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<void> {
  context.assertOutboundAllowed(route, "feed");
  const feedStartMeta = await context.composeMetaForOperation(route, "feed", payload, options);
  state.meta = feedStartMeta;

  context.postMessage({
    meta: feedStartMeta,
    type: "invoke_feed_start",
    sourceId: context.participantId,
    sentAtMs: Date.now(),
    requestId,
    route,
    operation: "feed",
    payload,
    payloadKey: state.payloadKey,
    payloadHash: state.payloadHash,
  });
}

function checkFeedDone(state: FeedQueueState): Error | "done" | null {
  if (!state.closed || state.queue.length > 0) {
    return null;
  }
  return state.terminalError ?? "done";
}

async function sendFeedStop(
  context: BrowserWindowsTransportClientContext,
  state: FeedQueueState,
  requestId: string,
  route: string,
  _options?: ScompClientInvokeOptions,
): Promise<void> {
  context.postMessage({
    type: "invoke_feed_stop",
    sourceId: context.participantId,
    sentAtMs: Date.now(),
    requestId,
    route,
    operation: "signal",
    method: "__scomp.unsubscribe",
    payloadKey: state.payloadKey,
    payloadHash: state.payloadHash,
    meta: state.meta,
  });
  state.stopSent = true;
}

async function cleanupFeed(
  context: BrowserWindowsTransportClientContext,
  state: FeedQueueState,
  requestId: string,
  route: string,
  feedStarted: boolean,
  options?: ScompClientInvokeOptions,
): Promise<void> {
  context.feedStates.delete(requestId);
  if (feedStarted && !state.stopSent) {
    await sendFeedStop(context, state, requestId, route, options);
  }
}

function throwIfTerminalError(state: FeedQueueState): void {
  if (state.terminalError) throw state.terminalError;
}

export function feedWithContext(
  context: BrowserWindowsTransportClientContext,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): AsyncIterable<unknown> {
  const requestId = createRequestId();
  const payloadKey = createPayloadKey(payload);
  const payloadHash = createPayloadHash(route, payload);

  return {
    [Symbol.asyncIterator]: async function* () {
      const state = initFeedState(route, payloadKey, payloadHash);
      context.feedStates.set(requestId, state);
      let feedStarted = false;

      try {
        await startFeed(context, state, requestId, route, payload, options);
        feedStarted = true;

        while (true) {
          if (state.queue.length > 0) {
            const nextValue = state.queue.shift();
            if (nextValue !== undefined) yield nextValue;
            const done = checkFeedDone(state);
            if (done === "done") return;
            if (done) throw done;
            continue;
          }

          if (state.closed) {
            throwIfTerminalError(state);
            return;
          }

          await new Promise<void>((resolve) => {
            state.waiters.push(resolve);
          });
        }
      } finally {
        await cleanupFeed(context, state, requestId, route, feedStarted, options);
      }
    },
  };
}

export function handleInvokeResponseMessage(
  pendingRequests: Map<BrowserWindowsRequestId, PendingRequestState>,
  message: BrowserWindowsInvokeResponseMessage,
  reportHealth: (
    code: BrowserWindowsTransportHealthReasonCode,
    detail: string | undefined,
    status: BrowserWindowsTransportHealthStatus,
  ) => void,
): void {
  const pending = pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }

  pendingRequests.delete(message.requestId);
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }

  if (message.error) {
    if (/host disconnected/i.test(message.error)) {
      reportHealth("host-disconnected", message.error, "degraded");
    }
    pending.reject(new Error(message.error));
    return;
  }

  pending.resolve(message.payload);
}

export function handleInvokeFeedChunkMessage(
  feedStates: Map<BrowserWindowsRequestId, FeedQueueState>,
  message: BrowserWindowsInvokeFeedChunkMessage,
  maxBufferedFeedChunksPerSubscriber: number,
  participantId: string,
  postMessage: (message: unknown) => void,
  reportHealth: (
    code: BrowserWindowsTransportHealthReasonCode,
    detail: string | undefined,
    status: BrowserWindowsTransportHealthStatus,
  ) => void,
): void {
  const state = feedStates.get(message.requestId);
  if (!state) {
    return;
  }

  if (message.chunkType === "next") {
    if (state.queue.length >= maxBufferedFeedChunksPerSubscriber) {
      terminateFeedState(
        message.requestId,
        state,
        new Error(
          `BrowserWindowsTransport feed buffer exceeded ${maxBufferedFeedChunksPerSubscriber} chunks for route ${state.route}.`,
        ),
        true,
        (payload) => postMessage(payload),
        participantId,
      );
      return;
    }

    state.queue.push(message.payload);
  } else if (message.chunkType === "error") {
    if (typeof message.message === "string" && /host disconnected/i.test(message.message)) {
      reportHealth("host-disconnected", message.message, "degraded");
    }
    terminateFeedState(
      message.requestId,
      state,
      new Error(message.message ?? "Feed error."),
      false,
      (payload) => postMessage(payload),
      participantId,
    );
    return;
  } else {
    terminateFeedState(message.requestId, state, undefined, false, (payload) => postMessage(payload), participantId);
    return;
  }

  while (state.waiters.length > 0) {
    state.waiters.shift()?.();
  }
}
