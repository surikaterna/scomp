import type { ScompClientInvokeOptions } from "@scomp/core";
import type { ScompTransportMessageMeta } from "@scomp/types";
import type {
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";
import {
  createPayloadHash,
  createPayloadKey,
  createRequestId,
} from "./shared-worker-internal";
import type {
  BrowserWindowsInvokeFeedChunkMessage,
  BrowserWindowsInvokeResponseMessage,
} from "./protocol";
import type { BrowserWindowsRequestId } from "./types";
import {
  type FeedQueueState,
  type PendingRequestState,
  rejectPendingRequest,
  terminateFeedState,
} from "./transport-browser-windows-state";

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
  assertOutboundAllowed(
    route: string,
    operation: "request" | "signal" | "feed",
  ): void;
  composeMetaForOperation(
    route: string,
    operation: "request" | "signal" | "feed",
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<{ meta: ScompTransportMessageMeta | undefined }>;
}

export async function requestWithContext(
  context: BrowserWindowsTransportClientContext,
  route: string,
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<unknown> {
  if (
    context.pendingRequests.size + context.getPreparingRequests() >=
    context.maxPendingRequests
  ) {
    throw new Error(
      `BrowserWindowsTransport max pending requests exceeded (${context.maxPendingRequests}).`,
    );
  }

  const requestId = createRequestId();
  context.incrementPreparingRequests();
  let meta: ScompTransportMessageMeta | undefined;
  try {
    context.assertOutboundAllowed(route, "request");
    meta = (
      await context.composeMetaForOperation(route, "request", payload, options)
    ).meta;
  } finally {
    context.decrementPreparingRequests();
  }

  const response = new Promise<unknown>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const pending = context.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }

      context.pendingRequests.delete(requestId);
      context.reportHealth(
        "request-timeout",
        `Request timed out for route: ${route}`,
        "degraded",
      );
      rejectPendingRequest(
        requestId,
        pending,
        new Error(
          `BrowserWindowsTransport request timed out after ${context.requestTimeoutMs}ms for route ${route}.`,
        ),
      );
    }, context.requestTimeoutMs);

    context.pendingRequests.set(requestId, { resolve, reject, timeoutId });
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
  const { meta } = await context.composeMetaForOperation(
    route,
    "signal",
    payload,
    options,
  );

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
      const state: FeedQueueState = {
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
      context.feedStates.set(requestId, state);

      let feedStarted = false;

      try {
        context.assertOutboundAllowed(route, "feed");
        const feedStartMeta = (
          await context.composeMetaForOperation(route, "feed", payload, options)
        ).meta;
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
        context.feedStates.delete(requestId);
        if (feedStarted && !state.stopSent) {
          context.assertOutboundAllowed(route, "signal");
          const feedStopMeta = (
            await context.composeMetaForOperation(
              route,
              "signal",
              { payloadKey: state.payloadKey, payloadHash: state.payloadHash },
              options,
            )
          ).meta;
          state.meta = feedStopMeta;

          context.postMessage({
            meta: feedStopMeta,
            type: "invoke_feed_stop",
            sourceId: context.participantId,
            sentAtMs: Date.now(),
            requestId,
            route,
            operation: "signal",
            method: "__scomp.unsubscribe",
            payloadKey: state.payloadKey,
            payloadHash: state.payloadHash,
          });
          state.stopSent = true;
        }
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
    if (
      typeof message.message === "string" &&
      /host disconnected/i.test(message.message)
    ) {
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
    terminateFeedState(
      message.requestId,
      state,
      undefined,
      false,
      (payload) => postMessage(payload),
      participantId,
    );
    return;
  }

  while (state.waiters.length > 0) {
    state.waiters.shift()?.();
  }
}
