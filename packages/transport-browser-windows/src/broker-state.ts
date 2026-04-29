import type { ScompTransportMessageMeta } from "@scomp/types";
import type {
  BrowserWindowsCanonicalPayloadHash,
  BrowserWindowsParticipantId,
  BrowserWindowsPayloadKey,
  BrowserWindowsRequestId,
} from "./types";

export interface BrowserWindowsPendingRequestState {
  requestId: BrowserWindowsRequestId;
  invokeId: BrowserWindowsParticipantId;
  hostId?: BrowserWindowsParticipantId;
  route: string;
  createdAtMs: number;
  meta?: ScompTransportMessageMeta;
}

export interface BrowserWindowsFeedSubscriptionState {
  route: string;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
  subscribersByRequestId: Map<BrowserWindowsRequestId, BrowserWindowsParticipantId>;
  metaByRequestId: Map<BrowserWindowsRequestId, ScompTransportMessageMeta | undefined>;
}

export interface BrowserWindowsUpstreamFeedOwnerState {
  route: string;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
  ownerHostId: BrowserWindowsParticipantId;
  sourceRequestId: BrowserWindowsRequestId;
  startedAtMs: number;
}

export type BrowserWindowsRouteHostRegistry = Map<string, Set<BrowserWindowsParticipantId>>;

export type BrowserWindowsPendingRequestMap = Map<BrowserWindowsRequestId, BrowserWindowsPendingRequestState>;

export type BrowserWindowsFeedSubscriptionKey =
  `${string}:${BrowserWindowsPayloadKey}:${BrowserWindowsCanonicalPayloadHash}`;

export type BrowserWindowsFeedSubscriptionMap = Map<
  BrowserWindowsFeedSubscriptionKey,
  BrowserWindowsFeedSubscriptionState
>;

export type BrowserWindowsActiveUpstreamFeedMap = Map<
  BrowserWindowsFeedSubscriptionKey,
  BrowserWindowsUpstreamFeedOwnerState
>;

export interface BrowserWindowsBrokerState {
  routeHosts: BrowserWindowsRouteHostRegistry;
  pendingRequests: BrowserWindowsPendingRequestMap;
  feedSubscriptions: BrowserWindowsFeedSubscriptionMap;
  activeUpstreamFeeds: BrowserWindowsActiveUpstreamFeedMap;
}
