import type { BrowserWindowsProtocolMessage } from "./protocol";

export interface BroadcastProtocolFrame {
  frameType: "protocol";
  sourceId: string;
  message: BrowserWindowsProtocolMessage;
}

export interface BroadcastLeaderHeartbeatFrame {
  frameType: "leader_heartbeat";
  sourceId: string;
  leaderId: string;
  leaseUntilMs: number;
  sentAtMs: number;
}

export interface BroadcastLeaderAnnounceFrame {
  frameType: "leader_announce";
  sourceId: string;
  leaderId: string;
  leaseUntilMs: number;
  sentAtMs: number;
}

export interface BroadcastLeaderRetireFrame {
  frameType: "leader_retire";
  sourceId: string;
  leaderId: string;
  sentAtMs: number;
}

export type BroadcastControlFrame =
  | BroadcastLeaderHeartbeatFrame
  | BroadcastLeaderAnnounceFrame
  | BroadcastLeaderRetireFrame;

export type BroadcastFallbackFrame = BroadcastProtocolFrame | BroadcastControlFrame;

export function isBroadcastFallbackFrame(
  value: unknown,
): value is BroadcastFallbackFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    "frameType" in value &&
    typeof (value as { frameType?: unknown }).frameType === "string"
  );
}

export function pickLeader(participants: Array<string>): string | undefined {
  if (participants.length === 0) {
    return undefined;
  }

  const sorted = [...participants].sort((a, b) => a.localeCompare(b));
  return sorted[0];
}
