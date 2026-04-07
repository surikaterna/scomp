import type {
  BrowserWindowsBrokerState,
  BrowserWindowsFeedSubscriptionKey,
} from "./broker-state";
import type {
  BrowserWindowsHostFeedChunkMessage,
  BrowserWindowsHostFeedStartedMessage,
  BrowserWindowsHostResponseMessage,
  BrowserWindowsInvokeFeedStartMessage,
  BrowserWindowsInvokeFeedStopMessage,
  BrowserWindowsInvokeRequestMessage,
  BrowserWindowsInvokeSignalMessage,
  BrowserWindowsProtocolMessage,
} from "./protocol";
import type { BrowserWindowsParticipantId } from "./types";

export interface BrowserWindowsMessagePortLike {
  postMessage(message: BrowserWindowsProtocolMessage): void;
  addEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  start?(): void;
}

function createBrokerState(): BrowserWindowsBrokerState {
  return {
    routeHosts: new Map(),
    pendingRequests: new Map(),
    feedSubscriptions: new Map(),
    activeUpstreamFeeds: new Map(),
  };
}

function createFeedKey(
  route: string,
  payloadKey: string,
  payloadHash: string,
): BrowserWindowsFeedSubscriptionKey {
  return `${route}:${payloadKey}:${payloadHash}`;
}

function cloneSet<T>(value: Set<T>): Array<T> {
  return Array.from(value);
}

export class BrowserWindowsSharedWorkerBroker {
  private readonly state = createBrokerState();
  private readonly portsByParticipant =
    new Map<BrowserWindowsParticipantId, BrowserWindowsMessagePortLike>();
  private readonly routesByParticipant =
    new Map<BrowserWindowsParticipantId, Set<string>>();

  attachPort(port: BrowserWindowsMessagePortLike): void {
    const listener = (event: { data: BrowserWindowsProtocolMessage }) => {
      this.handleMessage(port, event.data);
    };

    port.addEventListener("message", listener);
    port.start?.();
  }

  disconnectParticipant(participantId: BrowserWindowsParticipantId): void {
    this.portsByParticipant.delete(participantId);
    this.unregisterAllRoutes(participantId);
  }

  private handleMessage(
    sourcePort: BrowserWindowsMessagePortLike,
    message: BrowserWindowsProtocolMessage,
  ): void {
    if (!message?.sourceId) {
      return;
    }

    this.portsByParticipant.set(message.sourceId, sourcePort);

    switch (message.type) {
      case "hello":
        this.sendTo(sourcePort, {
          type: "hello_ack",
          sourceId: "broker",
          targetId: message.sourceId,
          sentAtMs: Date.now(),
          meta: message.meta,
        });
        return;
      case "routes_register":
        this.registerRoutes(message.sourceId, message.routes);
        return;
      case "routes_unregister":
        this.unregisterRoutes(message.sourceId, message.routes);
        return;
      case "invoke_request":
        this.handleInvokeRequest(message);
        return;
      case "invoke_signal":
        this.handleInvokeSignal(message);
        return;
      case "invoke_feed_start":
        this.handleInvokeFeedStart(message);
        return;
      case "invoke_feed_stop":
        this.handleInvokeFeedStop(message);
        return;
      case "host_response":
        this.handleHostResponse(message);
        return;
      case "host_feed_started":
        this.handleHostFeedStarted(message);
        return;
      case "host_feed_chunk":
        this.handleHostFeedChunk(message);
        return;
      case "heartbeat":
      case "hello_ack":
      case "host_request":
      case "host_signal":
      case "host_feed_start":
      case "host_feed_stop":
      case "invoke_response":
      case "invoke_feed_chunk":
        return;
      default:
        return;
    }
  }

  private registerRoutes(
    participantId: BrowserWindowsParticipantId,
    routes: Array<string>,
  ): void {
    const participantRoutes =
      this.routesByParticipant.get(participantId) ?? new Set<string>();
    this.routesByParticipant.set(participantId, participantRoutes);

    for (const route of routes) {
      participantRoutes.add(route);
      const hosts = this.state.routeHosts.get(route) ?? new Set();
      hosts.add(participantId);
      this.state.routeHosts.set(route, hosts);
    }
  }

  private unregisterRoutes(
    participantId: BrowserWindowsParticipantId,
    routes: Array<string>,
  ): void {
    const participantRoutes = this.routesByParticipant.get(participantId);
    if (!participantRoutes) {
      return;
    }

    for (const route of routes) {
      participantRoutes.delete(route);
      const hosts = this.state.routeHosts.get(route);
      if (!hosts) {
        continue;
      }

      hosts.delete(participantId);
      if (hosts.size === 0) {
        this.state.routeHosts.delete(route);
      }
    }
  }

  private unregisterAllRoutes(participantId: BrowserWindowsParticipantId): void {
    const participantRoutes = this.routesByParticipant.get(participantId);
    if (!participantRoutes) {
      return;
    }

    this.routesByParticipant.delete(participantId);
    for (const route of participantRoutes) {
      const hosts = this.state.routeHosts.get(route);
      if (!hosts) {
        continue;
      }

      hosts.delete(participantId);
      if (hosts.size === 0) {
        this.state.routeHosts.delete(route);
      }
    }
  }

  private pickHost(route: string): BrowserWindowsParticipantId | undefined {
    const hosts = this.state.routeHosts.get(route);
    if (!hosts || hosts.size === 0) {
      return undefined;
    }

    return cloneSet(hosts)[0];
  }

  private handleInvokeRequest(message: BrowserWindowsInvokeRequestMessage): void {
    const hostId = this.pickHost(message.route);
    if (!hostId) {
      this.sendToParticipant(message.sourceId, {
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

    this.state.pendingRequests.set(message.requestId, {
      requestId: message.requestId,
      invokeId: message.sourceId,
      hostId,
      route: message.route,
      createdAtMs: Date.now(),
    });

    this.sendToParticipant(hostId, {
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

  private handleInvokeSignal(message: BrowserWindowsInvokeSignalMessage): void {
    const hosts = this.state.routeHosts.get(message.route);
    if (!hosts || hosts.size === 0) {
      return;
    }

    for (const hostId of hosts) {
      this.sendToParticipant(hostId, {
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

  private handleInvokeFeedStart(
    message: BrowserWindowsInvokeFeedStartMessage,
  ): void {
    const hostId = this.pickHost(message.route);
    if (!hostId) {
      this.sendToParticipant(message.sourceId, {
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

    this.state.pendingRequests.set(message.requestId, {
      requestId: message.requestId,
      invokeId: message.sourceId,
      hostId,
      route: message.route,
      createdAtMs: Date.now(),
    });

    const key = createFeedKey(
      message.route,
      message.payloadKey,
      message.payloadHash,
    );

    const subscription = this.state.feedSubscriptions.get(key) ?? {
      route: message.route,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      requestIds: new Set(),
      invokeIds: new Set(),
    };

    subscription.requestIds.add(message.requestId);
    subscription.invokeIds.add(message.sourceId);
    this.state.feedSubscriptions.set(key, subscription);

    this.sendToParticipant(hostId, {
      type: "host_feed_start",
      sourceId: "broker",
      targetId: hostId,
      sentAtMs: Date.now(),
      invokeId: message.sourceId,
      requestId: message.requestId,
      route: message.route,
      operation: "feed_start",
      payload: message.payload,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      meta: message.meta,
    });
  }

  private handleInvokeFeedStop(message: BrowserWindowsInvokeFeedStopMessage): void {
    const pending = this.state.pendingRequests.get(message.requestId);
    if (!pending?.hostId) {
      return;
    }

    const hostId = pending.hostId;
    this.sendToParticipant(hostId, {
      type: "host_feed_stop",
      sourceId: "broker",
      targetId: hostId,
      sentAtMs: Date.now(),
      invokeId: pending.invokeId,
      requestId: message.requestId,
      route: pending.route,
      operation: "feed_stop",
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      meta: message.meta,
    });

    this.removeFeedSubscription(
      pending.route,
      message.payloadKey,
      message.payloadHash,
      message.requestId,
      pending.invokeId,
    );

    this.state.pendingRequests.delete(message.requestId);
  }

  private handleHostResponse(message: BrowserWindowsHostResponseMessage): void {
    const pending = this.state.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.sendToParticipant(pending.invokeId, {
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

    this.state.pendingRequests.delete(message.requestId);
  }

  private handleHostFeedStarted(message: BrowserWindowsHostFeedStartedMessage): void {
    const key = createFeedKey(
      this.state.pendingRequests.get(message.requestId)?.route ?? "",
      message.payloadKey,
      message.payloadHash,
    );

    this.state.activeUpstreamFeeds.set(key, {
      route: this.state.pendingRequests.get(message.requestId)?.route ?? "",
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      ownerHostId: message.hostId,
      sourceRequestId: message.requestId,
      startedAtMs: Date.now(),
    });
  }

  private handleHostFeedChunk(message: BrowserWindowsHostFeedChunkMessage): void {
    const pending = this.state.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.sendToParticipant(pending.invokeId, {
      type: "invoke_feed_chunk",
      sourceId: "broker",
      targetId: pending.invokeId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      hostId: message.hostId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: message.chunkType,
      payload: message.payload,
      message: message.message,
      meta: message.meta,
    });

    if (message.chunkType === "done" || message.chunkType === "error") {
      this.removeFeedSubscription(
        pending.route,
        message.payloadKey,
        message.payloadHash,
        message.requestId,
        pending.invokeId,
      );
      this.state.pendingRequests.delete(message.requestId);
    }
  }

  private removeFeedSubscription(
    route: string,
    payloadKey: string,
    payloadHash: string,
    requestId: string,
    invokeId: string,
  ): void {
    const key = createFeedKey(route, payloadKey, payloadHash);
    const subscription = this.state.feedSubscriptions.get(key);
    if (!subscription) {
      return;
    }

    subscription.requestIds.delete(requestId);
    subscription.invokeIds.delete(invokeId);

    if (subscription.requestIds.size === 0) {
      this.state.feedSubscriptions.delete(key);
      this.state.activeUpstreamFeeds.delete(key);
    }
  }

  private sendToParticipant(
    participantId: BrowserWindowsParticipantId,
    message: BrowserWindowsProtocolMessage,
  ): void {
    const port = this.portsByParticipant.get(participantId);
    if (!port) {
      return;
    }

    this.sendTo(port, message);
  }

  private sendTo(
    port: BrowserWindowsMessagePortLike,
    message: BrowserWindowsProtocolMessage,
  ): void {
    port.postMessage(message);
  }
}
