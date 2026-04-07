import type { ScompTransportMessageMeta } from "@scomp/types";

export type BrowserWindowsTransportMode = "shared-worker" | "broadcast-channel";

export type BrowserWindowsTransportModePreference =
  | BrowserWindowsTransportMode
  | "auto";

export type BrowserWindowsParticipantRole = "broker" | "host" | "invoke";

export type BrowserWindowsParticipantId = string;

export type BrowserWindowsRequestId = string;

export type BrowserWindowsPayloadKey = string;

export type BrowserWindowsCanonicalPayloadHash = string;

export interface BrowserWindowsTransportConfig {
  mode?: BrowserWindowsTransportModePreference;
  channelName?: string;
  workerUrl?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  nodeId?: BrowserWindowsParticipantId;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
}
