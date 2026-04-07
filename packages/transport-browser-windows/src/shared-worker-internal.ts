import type { ScompClientInvokeOptions } from "@scomp/core";
import { createFeedHash, type ScompTransportMessageMeta } from "@scomp/types";
import type {
  BrowserWindowsCanonicalPayloadHash,
  BrowserWindowsParticipantId,
  BrowserWindowsPayloadKey,
  BrowserWindowsRequestId,
  BrowserWindowsTransportConfig,
} from "./types";

export function createRuntimeId(prefix: string): string {
  const globalCrypto = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  const uuid = globalCrypto?.randomUUID?.();
  if (uuid) {
    return `${prefix}-${uuid}`;
  }

  const random = Math.random().toString(16).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createParticipantId(
  config: BrowserWindowsTransportConfig,
): BrowserWindowsParticipantId {
  return config.nodeId ?? createRuntimeId("bw");
}

export function createRequestId(): BrowserWindowsRequestId {
  return createRuntimeId("req");
}

export function createPayloadKey(payload: unknown): BrowserWindowsPayloadKey {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return String(payload);
  }
}

export function createPayloadHash(
  route: string,
  payload: unknown,
): BrowserWindowsCanonicalPayloadHash {
  return createFeedHash(route, payload);
}

export function toPriorityMeta(
  options?: ScompClientInvokeOptions,
): ScompTransportMessageMeta | undefined {
  if (!options) {
    return undefined;
  }

  const { priority, priorityClass, deadlineAtMs, targetLatencyMs } = options;
  if (
    priority === undefined &&
    priorityClass === undefined &&
    deadlineAtMs === undefined &&
    targetLatencyMs === undefined
  ) {
    return undefined;
  }

  const meta: ScompTransportMessageMeta = {};
  if (priority !== undefined) {
    meta.priority = priority;
  }
  if (priorityClass !== undefined) {
    meta.priorityClass = priorityClass;
  }
  if (deadlineAtMs !== undefined) {
    meta.deadlineAtMs = deadlineAtMs;
  }
  if (targetLatencyMs !== undefined) {
    meta.targetLatencyMs = targetLatencyMs;
  }
  return meta;
}

export function mergeMeta(
  baseMeta: ScompTransportMessageMeta | undefined,
  overlayMeta: ScompTransportMessageMeta | undefined,
): ScompTransportMessageMeta | undefined {
  if (!baseMeta && !overlayMeta) {
    return undefined;
  }

  return {
    ...(baseMeta ?? {}),
    ...(overlayMeta ?? {}),
  };
}
