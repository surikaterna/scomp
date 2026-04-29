import type { BrowserWindowsBrokerState, BrowserWindowsFeedSubscriptionKey } from "./broker-state";
import type { BrowserWindowsProtocolMessage } from "./protocol";
import type { BrowserWindowsParticipantId } from "./types";
import type { BrowserWindowsMessagePortLike } from "./shared-worker-broker";

export interface BrokerContext {
  state: BrowserWindowsBrokerState;
  portsByParticipant: Map<BrowserWindowsParticipantId, BrowserWindowsMessagePortLike>;
  routesByParticipant: Map<BrowserWindowsParticipantId, Set<string>>;
  sendToParticipant(participantId: BrowserWindowsParticipantId, message: BrowserWindowsProtocolMessage): void;
  sendTo(port: BrowserWindowsMessagePortLike, message: BrowserWindowsProtocolMessage): void;
}

export function createBrokerState(): BrowserWindowsBrokerState {
  return {
    routeHosts: new Map(),
    pendingRequests: new Map(),
    feedSubscriptions: new Map(),
    activeUpstreamFeeds: new Map(),
  };
}

export function createFeedKey(
  route: string,
  payloadKey: string,
  payloadHash: string,
): BrowserWindowsFeedSubscriptionKey {
  return `${route}:${payloadKey}:${payloadHash}`;
}

export function cloneSet<T>(value: Set<T>): Array<T> {
  return Array.from(value);
}
