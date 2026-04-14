import type { ScompTransportMessageMeta } from "@scomp/types";
import type { BrowserWindowsRequestId } from "./types";

export interface PendingRequestState {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface FeedQueueState {
  queue: Array<unknown>;
  waiters: Array<() => void>;
  closed: boolean;
  stopSent: boolean;
  terminalError?: Error;
  route: string;
  payloadKey: string;
  payloadHash: string;
  meta?: ScompTransportMessageMeta;
}

export interface HostedFeedState {
  stopped: boolean;
  unsubscribe?: () => void;
}

export interface RuntimeRoute {
  parser?: (payload: unknown) => unknown;
  handler: (payload: unknown) => unknown;
  kind?: "request" | "signal" | "feed";
}

export function routeOperation(route: unknown): "request" | "signal" | "feed" {
  const routeRecord = route as { kind?: string };
  if (routeRecord?.kind === "signal") {
    return "signal";
  }

  if (routeRecord?.kind === "feed") {
    return "feed";
  }

  return "request";
}

export function rejectPendingRequest(
  _requestId: BrowserWindowsRequestId,
  pending: PendingRequestState,
  error: Error,
): void {
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  pending.reject(error);
}

export function terminateFeedState(
  requestId: BrowserWindowsRequestId,
  state: FeedQueueState,
  error: Error | undefined,
  shouldNotifyStop: boolean,
  postMessage: (message: {
    type: "invoke_feed_stop";
    sourceId: string;
    sentAtMs: number;
    requestId: BrowserWindowsRequestId;
    route: string;
    operation: "signal";
    method: "__scomp.unsubscribe";
    payloadKey: string;
    payloadHash: string;
    meta?: ScompTransportMessageMeta;
  }) => void,
  participantId: string,
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

    postMessage({
      type: "invoke_feed_stop",
      sourceId: participantId,
      sentAtMs: Date.now(),
      requestId,
      route: state.route,
      operation: "signal",
      method: "__scomp.unsubscribe",
      payloadKey: state.payloadKey,
      payloadHash: state.payloadHash,
      meta: state.meta,
    });
    state.stopSent = true;
  }
}
