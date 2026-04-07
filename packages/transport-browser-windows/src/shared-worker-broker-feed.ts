import type {
  BrowserWindowsFeedSubscriptionState,
  BrowserWindowsFeedSubscriptionKey,
} from "./broker-state";
import { createFeedKey, type BrokerContext } from "./shared-worker-broker-context";

export function failFeedSubscription(
  context: BrokerContext,
  subscription: BrowserWindowsFeedSubscriptionState,
  errorMessage: string,
): void {
  for (const [subscriberRequestId, subscriberInvokeId] of subscription.subscribersByRequestId) {
    context.sendToParticipant(subscriberInvokeId, {
      type: "invoke_feed_chunk",
      sourceId: "broker",
      targetId: subscriberInvokeId,
      sentAtMs: Date.now(),
      requestId: subscriberRequestId,
      hostId: "broker",
      payloadKey: subscription.payloadKey,
      payloadHash: subscription.payloadHash,
      chunkType: "error",
      message: errorMessage,
    });
    context.state.pendingRequests.delete(subscriberRequestId);
  }
}

export function removeFeedSubscription(
  context: BrokerContext,
  route: string,
  payloadKey: string,
  payloadHash: string,
  requestId: string,
): BrowserWindowsFeedSubscriptionKey | undefined {
  const key = createFeedKey(route, payloadKey, payloadHash);
  const subscription = context.state.feedSubscriptions.get(key);
  if (!subscription) {
    return undefined;
  }

  subscription.subscribersByRequestId.delete(requestId);

  if (subscription.subscribersByRequestId.size === 0) {
    context.state.feedSubscriptions.delete(key);
    return key;
  }

  return undefined;
}

export function findUpstreamKeyBySourceRequestId(
  context: BrokerContext,
  requestId: string,
): BrowserWindowsFeedSubscriptionKey | undefined {
  for (const [key, state] of context.state.activeUpstreamFeeds.entries()) {
    if (state.sourceRequestId === requestId) {
      return key;
    }
  }

  return undefined;
}
