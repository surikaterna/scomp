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
  workerName?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  nodeId?: BrowserWindowsParticipantId;
  sharedWorkerCtor?: BrowserWindowsSharedWorkerCtor;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
}

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
