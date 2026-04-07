import type {
  ScompTransportMessageMeta,
  ScompTransportSecurityPolicy,
} from "@scomp/types";

export type BrowserWindowsTransportMode = "shared-worker" | "broadcast-channel";

export type BrowserWindowsTransportModePreference =
  | BrowserWindowsTransportMode
  | "auto";

export type BrowserWindowsTransportHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable";

export type BrowserWindowsTransportHealthReasonCode =
  | "shared-worker-unavailable"
  | "broadcast-channel-unavailable"
  | "leader-failover"
  | "host-disconnected"
  | "auth-denied"
  | "request-timeout"
  | "publish-failed";

export interface BrowserWindowsTransportHealthReason {
  code: BrowserWindowsTransportHealthReasonCode;
  detail?: string;
  atMs: number;
}

export interface BrowserWindowsTransportHealthSnapshot {
  status: BrowserWindowsTransportHealthStatus;
  reasons: Array<BrowserWindowsTransportHealthReason>;
  activeMode?: BrowserWindowsTransportMode;
  updatedAtMs: number;
}

export type BrowserWindowsTransportHealthListener = (
  snapshot: BrowserWindowsTransportHealthSnapshot,
) => void;

export interface BrowserWindowsTransportHealthConfig {
  onSnapshot?: BrowserWindowsTransportHealthListener;
}

export type BrowserWindowsParticipantRole = "broker" | "host" | "invoke";

export type BrowserWindowsParticipantId = string;

export type BrowserWindowsRequestId = string;

export type BrowserWindowsPayloadKey = string;

export type BrowserWindowsCanonicalPayloadHash = string;

export type BrowserWindowsRouteIntentKind = "request" | "signal" | "feed";

export interface BrowserWindowsRouteIntent {
  route: string;
  kind: BrowserWindowsRouteIntentKind;
}

export type BrowserWindowsRouteIntentMap = Readonly<
  Record<string, BrowserWindowsRouteIntentKind>
>;

export interface BrowserWindowsTransportConfig {
  mode?: BrowserWindowsTransportModePreference;
  sharedWorkerStrict?: boolean;
  strictRouteIntents?: boolean;
  routeIntents?: BrowserWindowsRouteIntentMap | ReadonlyArray<BrowserWindowsRouteIntent>;
  channelName?: string;
  workerUrl?: string;
  workerName?: string;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  maxBufferedFeedChunksPerSubscriber?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  nodeId?: BrowserWindowsParticipantId;
  sharedWorkerCtor?: BrowserWindowsSharedWorkerCtor;
  broadcastChannelCtor?: BrowserWindowsBroadcastChannelCtor;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  security?: ScompTransportSecurityPolicy;
  health?: BrowserWindowsTransportHealthConfig;
}

export interface BrowserWindowsBroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  close(): void;
}

export type BrowserWindowsBroadcastChannelCtor = new (
  name: string,
) => BrowserWindowsBroadcastChannelLike;

export interface BrowserWindowsSharedWorkerPortLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  start?(): void;
  close?(): void;
}

export interface BrowserWindowsSharedWorkerLike {
  port: BrowserWindowsSharedWorkerPortLike;
}

export type BrowserWindowsSharedWorkerCtor = new (
  scriptUrl: string,
  optionsOrName?: { name?: string } | string,
) => BrowserWindowsSharedWorkerLike;
