import type { BrowserWindowsProtocolMessage } from "./protocol";
import type { BrowserWindowsTransportMode } from "./types";

export interface BrowserWindowsFallbackConnector {
  readonly activeMode: BrowserWindowsTransportMode;
  addMessageListener(listener: (data: unknown) => void): void;
  removeMessageListener(listener: (data: unknown) => void): void;
  addRuntimeEventListener(listener: (event: BrowserWindowsFallbackRuntimeEvent) => void): void;
  removeRuntimeEventListener(listener: (event: BrowserWindowsFallbackRuntimeEvent) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

export interface BrowserWindowsFallbackRuntimeEvent {
  type: "leader-failover";
  previousLeaderId: string;
  nextLeaderId: string;
  atMs: number;
}

export function emitFallbackRuntimeEvent(
  listeners: ReadonlySet<(event: BrowserWindowsFallbackRuntimeEvent) => void>,
  event: BrowserWindowsFallbackRuntimeEvent,
): void {
  for (const listener of listeners) {
    listener(event);
  }
}

export function isProtocolMessage(value: unknown): value is BrowserWindowsProtocolMessage {
  return typeof value === "object" && value !== null && "type" in value;
}
