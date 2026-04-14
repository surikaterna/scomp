import type {
  BrowserWindowsParticipantId,
  BrowserWindowsRequestId,
} from "./types";
import type {
  FeedQueueState,
  HostedFeedState,
  PendingRequestState,
} from "./transport-browser-windows-state";
import { rejectPendingRequest } from "./transport-browser-windows-state";

export function sendHello(
  participantId: BrowserWindowsParticipantId,
  publishMessage: (message: unknown) => void,
): void {
  publishMessage({
    type: "hello",
    sourceId: participantId,
    sentAtMs: Date.now(),
  });
}

export function syncRoutes(
  participantId: BrowserWindowsParticipantId,
  previousRoutes: Array<string>,
  nextRoutes: Array<string>,
  publishMessage: (message: unknown) => void,
): void {
  if (previousRoutes.length > 0) {
    publishMessage({
      type: "routes_unregister",
      sourceId: participantId,
      sentAtMs: Date.now(),
      routes: previousRoutes,
    });
  }

  if (nextRoutes.length > 0) {
    publishMessage({
      type: "routes_register",
      sourceId: participantId,
      sentAtMs: Date.now(),
      routes: nextRoutes,
    });
  }
}

export function shutdownTransport(options: {
  participantId: BrowserWindowsParticipantId;
  routes: Array<string>;
  pendingRequests: Map<BrowserWindowsRequestId, PendingRequestState>;
  feedStates: Map<BrowserWindowsRequestId, FeedQueueState>;
  hostedFeeds: Map<BrowserWindowsRequestId, HostedFeedState>;
  publishMessage: (message: unknown) => void;
  removeMessageListener: () => void;
  removeRuntimeEventListener: () => void;
  closeConnector: () => void;
}): void {
  if (options.routes.length > 0) {
    options.publishMessage({
      type: "routes_unregister",
      sourceId: options.participantId,
      sentAtMs: Date.now(),
      routes: options.routes,
    });
  }

  options.publishMessage({
    type: "participant_disconnect",
    sourceId: options.participantId,
    sentAtMs: Date.now(),
  });

  options.removeMessageListener();
  options.removeRuntimeEventListener();

  for (const [requestId, pending] of options.pendingRequests.entries()) {
    rejectPendingRequest(
      requestId,
      pending,
      new Error("BrowserWindowsTransport closed."),
    );
  }
  options.pendingRequests.clear();

  for (const [requestId, feed] of options.feedStates.entries()) {
    feed.closed = true;
    feed.terminalError = new Error("BrowserWindowsTransport closed.");
    feed.queue.length = 0;

    while (feed.waiters.length > 0) {
      feed.waiters.shift()?.();
    }

    if (!feed.stopSent) {
      options.publishMessage({
        type: "invoke_feed_stop",
        sourceId: options.participantId,
        sentAtMs: Date.now(),
        requestId,
        route: feed.route,
        operation: "signal",
        method: "__scomp.unsubscribe",
        payloadKey: feed.payloadKey,
        payloadHash: feed.payloadHash,
        meta: feed.meta,
      });
      feed.stopSent = true;
    }
  }
  options.feedStates.clear();

  for (const hostedFeed of options.hostedFeeds.values()) {
    hostedFeed.stopped = true;
    hostedFeed.unsubscribe?.();
  }
  options.hostedFeeds.clear();

  options.closeConnector();
}
