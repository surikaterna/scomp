import { createFeedHash } from "@scompr/core";
import type {
  BrowserWindowsCanonicalPayloadHash,
  BrowserWindowsParticipantId,
  BrowserWindowsPayloadKey,
  BrowserWindowsRequestId,
  BrowserWindowsTransportConfig,
} from "./types";

export function createRuntimeId(prefix: string): string {
  const globalCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const uuid = globalCrypto?.randomUUID?.();
  if (uuid) {
    return `${prefix}-${uuid}`;
  }

  const random = Math.random().toString(16).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createParticipantId(config: BrowserWindowsTransportConfig): BrowserWindowsParticipantId {
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

export function createPayloadHash(route: string, payload: unknown): BrowserWindowsCanonicalPayloadHash {
  return createFeedHash(route, payload);
}
