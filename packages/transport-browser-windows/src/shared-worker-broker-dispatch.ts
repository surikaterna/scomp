import type {
  BrowserWindowsHostFeedChunkMessage,
  BrowserWindowsHostFeedStartedMessage,
  BrowserWindowsHostResponseMessage,
  BrowserWindowsInvokeFeedStartMessage,
  BrowserWindowsInvokeFeedStopMessage,
  BrowserWindowsInvokeRequestMessage,
  BrowserWindowsInvokeSignalMessage,
} from "./protocol";
import { type BrokerContext, createFeedKey } from "./shared-worker-broker-context";
import { findUpstreamKeyBySourceRequestId, removeFeedSubscription } from "./shared-worker-broker-feed";
import { pickHost } from "./shared-worker-broker-routes";

export function handleInvokeRequest(context: BrokerContext, message: BrowserWindowsInvokeRequestMessage): void {
  const hostId = pickHost(context, message.route);
  if (!hostId) {
    context.sendToParticipant(message.sourceId, {
      type: "invoke_response",
      sourceId: "broker",
      targetId: message.sourceId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      hostId: "broker",
      error: `No host registered for route: ${message.route}`,
      meta: message.meta,
    });
    return;
  }

  context.state.pendingRequests.set(message.requestId, {
    requestId: message.requestId,
    invokeId: message.sourceId,
    hostId,
    route: message.route,
    createdAtMs: Date.now(),
    meta: message.meta,
  });

  context.sendToParticipant(hostId, {
    type: "host_request",
    sourceId: "broker",
    targetId: hostId,
    sentAtMs: Date.now(),
    invokeId: message.sourceId,
    requestId: message.requestId,
    route: message.route,
    operation: "request",
    payload: message.payload,
    meta: message.meta,
  });
}

export function handleInvokeSignal(context: BrokerContext, message: BrowserWindowsInvokeSignalMessage): void {
  const hosts = context.state.routeHosts.get(message.route);
  if (!hosts || hosts.size === 0) {
    return;
  }

  for (const hostId of hosts) {
    context.sendToParticipant(hostId, {
      type: "host_signal",
      sourceId: "broker",
      targetId: hostId,
      sentAtMs: Date.now(),
      invokeId: message.sourceId,
      requestId: message.requestId,
      route: message.route,
      operation: "signal",
      payload: message.payload,
      meta: message.meta,
    });
  }
}

export function handleInvokeFeedStart(context: BrokerContext, message: BrowserWindowsInvokeFeedStartMessage): void {
  const hostId = pickHost(context, message.route);
  if (!hostId) {
    context.sendToParticipant(message.sourceId, {
      type: "invoke_feed_chunk",
      sourceId: "broker",
      targetId: message.sourceId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      hostId: "broker",
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: "error",
      message: `No host registered for route: ${message.route}`,
      meta: message.meta,
    });
    return;
  }

  const key = createFeedKey(message.route, message.payloadKey, message.payloadHash);

  const subscription = context.state.feedSubscriptions.get(key) ?? {
    route: message.route,
    payloadKey: message.payloadKey,
    payloadHash: message.payloadHash,
    subscribersByRequestId: new Map(),
    metaByRequestId: new Map(),
  };

  subscription.subscribersByRequestId.set(message.requestId, message.sourceId);
  subscription.metaByRequestId.set(message.requestId, message.meta);
  context.state.feedSubscriptions.set(key, subscription);

  context.state.pendingRequests.set(message.requestId, {
    requestId: message.requestId,
    invokeId: message.sourceId,
    hostId,
    route: message.route,
    createdAtMs: Date.now(),
    meta: message.meta,
  });

  const activeUpstream = context.state.activeUpstreamFeeds.get(key);
  if (activeUpstream) {
    return;
  }

  context.state.activeUpstreamFeeds.set(key, {
    route: message.route,
    payloadKey: message.payloadKey,
    payloadHash: message.payloadHash,
    ownerHostId: hostId,
    sourceRequestId: message.requestId,
    startedAtMs: 0,
  });

  context.sendToParticipant(hostId, {
    type: "host_feed_start",
    sourceId: "broker",
    targetId: hostId,
    sentAtMs: Date.now(),
    invokeId: message.sourceId,
    requestId: message.requestId,
    route: message.route,
    operation: "feed",
    payload: message.payload,
    payloadKey: message.payloadKey,
    payloadHash: message.payloadHash,
    meta: message.meta,
  });
}

export function handleInvokeFeedStop(context: BrokerContext, message: BrowserWindowsInvokeFeedStopMessage): void {
  const pending = context.state.pendingRequests.get(message.requestId);
  if (!pending?.hostId) {
    return;
  }

  const key = removeFeedSubscription(
    context,
    pending.route,
    message.payloadKey,
    message.payloadHash,
    message.requestId,
  );

  context.state.pendingRequests.delete(message.requestId);

  if (!key) {
    return;
  }

  const activeUpstream = context.state.activeUpstreamFeeds.get(key);
  if (!activeUpstream) {
    return;
  }

  context.sendToParticipant(activeUpstream.ownerHostId, {
    type: "host_feed_stop",
    sourceId: "broker",
    targetId: activeUpstream.ownerHostId,
    sentAtMs: Date.now(),
    invokeId: pending.invokeId,
    requestId: activeUpstream.sourceRequestId,
    route: activeUpstream.route,
    operation: "signal",
    method: "__scomp.unsubscribe",
    payloadKey: activeUpstream.payloadKey,
    payloadHash: activeUpstream.payloadHash,
    meta: message.meta,
  });

  context.state.activeUpstreamFeeds.delete(key);
}

export function handleHostResponse(context: BrokerContext, message: BrowserWindowsHostResponseMessage): void {
  const pending = context.state.pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }

  context.sendToParticipant(pending.invokeId, {
    type: "invoke_response",
    sourceId: "broker",
    targetId: pending.invokeId,
    sentAtMs: Date.now(),
    requestId: message.requestId,
    hostId: message.hostId,
    payload: message.payload,
    error: message.error,
    meta: message.meta,
  });

  context.state.pendingRequests.delete(message.requestId);
}

export function handleHostFeedStarted(context: BrokerContext, message: BrowserWindowsHostFeedStartedMessage): void {
  const pending = context.state.pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }

  const key = createFeedKey(pending.route, message.payloadKey, message.payloadHash);
  const existing = context.state.activeUpstreamFeeds.get(key);
  if (!existing) {
    return;
  }

  context.state.activeUpstreamFeeds.set(key, {
    ...existing,
    ownerHostId: message.hostId,
    startedAtMs: Date.now(),
  });
}

export function handleHostFeedChunk(context: BrokerContext, message: BrowserWindowsHostFeedChunkMessage): void {
  const key = findUpstreamKeyBySourceRequestId(context, message.requestId);
  if (!key) {
    return;
  }

  const subscription = context.state.feedSubscriptions.get(key);
  if (!subscription) {
    return;
  }

  for (const [subscriberRequestId, subscriberInvokeId] of subscription.subscribersByRequestId) {
    const subscriberMeta = subscription.metaByRequestId.get(subscriberRequestId);
    context.sendToParticipant(subscriberInvokeId, {
      type: "invoke_feed_chunk",
      sourceId: "broker",
      targetId: subscriberInvokeId,
      sentAtMs: Date.now(),
      requestId: subscriberRequestId,
      hostId: message.hostId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: message.chunkType,
      payload: message.payload,
      message: message.message,
      meta: subscriberMeta,
    });
  }

  if (message.chunkType === "done" || message.chunkType === "error") {
    for (const subscriberRequestId of subscription.subscribersByRequestId.keys()) {
      context.state.pendingRequests.delete(subscriberRequestId);
    }

    context.state.feedSubscriptions.delete(key);
    context.state.activeUpstreamFeeds.delete(key);
  }
}
