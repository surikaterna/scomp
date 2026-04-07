import {
  failFeedSubscription,
} from "./shared-worker-broker-feed";
import { unregisterAllRoutes } from "./shared-worker-broker-routes";
import type { BrowserWindowsParticipantId } from "./types";
import { type BrokerContext } from "./shared-worker-broker-context";

export function cleanupDisconnectedParticipant(
  context: BrokerContext,
  participantId: BrowserWindowsParticipantId,
): void {
  unregisterAllRoutes(context, participantId);

  for (const [key, subscription] of context.state.feedSubscriptions.entries()) {
    for (const [requestId, invokeId] of subscription.subscribersByRequestId.entries()) {
      if (invokeId !== participantId) {
        continue;
      }

      subscription.subscribersByRequestId.delete(requestId);
      context.state.pendingRequests.delete(requestId);
    }

    if (subscription.subscribersByRequestId.size > 0) {
      continue;
    }

    context.state.feedSubscriptions.delete(key);
    const activeUpstream = context.state.activeUpstreamFeeds.get(key);
    if (!activeUpstream) {
      continue;
    }

    context.sendToParticipant(activeUpstream.ownerHostId, {
      type: "host_feed_stop",
      sourceId: "broker",
      targetId: activeUpstream.ownerHostId,
      sentAtMs: Date.now(),
      invokeId: participantId,
      requestId: activeUpstream.sourceRequestId,
      route: activeUpstream.route,
      operation: "feed_stop",
      payloadKey: activeUpstream.payloadKey,
      payloadHash: activeUpstream.payloadHash,
    });

    context.state.activeUpstreamFeeds.delete(key);
    context.state.pendingRequests.delete(activeUpstream.sourceRequestId);
  }

  for (const [key, activeUpstream] of context.state.activeUpstreamFeeds.entries()) {
    if (activeUpstream.ownerHostId !== participantId) {
      continue;
    }

    const subscription = context.state.feedSubscriptions.get(key);
    if (subscription) {
      failFeedSubscription(
        context,
        subscription,
        `Feed host disconnected for route: ${activeUpstream.route}`,
      );
      context.state.feedSubscriptions.delete(key);
    }

    context.state.activeUpstreamFeeds.delete(key);
    context.state.pendingRequests.delete(activeUpstream.sourceRequestId);
  }

  for (const [requestId, pending] of context.state.pendingRequests.entries()) {
    if (pending.invokeId === participantId) {
      context.state.pendingRequests.delete(requestId);
      continue;
    }

    if (pending.hostId === participantId) {
      context.sendToParticipant(pending.invokeId, {
        type: "invoke_response",
        sourceId: "broker",
        targetId: pending.invokeId,
        sentAtMs: Date.now(),
        requestId: pending.requestId,
        hostId: participantId,
        error: `Host disconnected for route: ${pending.route}`,
      });
      context.state.pendingRequests.delete(requestId);
    }
  }
}
