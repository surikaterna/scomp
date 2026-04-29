import type {
  BroadcastControlFrame,
  BroadcastLeaderAnnounceFrame,
  BroadcastLeaderHeartbeatFrame,
  BroadcastLeaderRetireFrame,
} from "./broadcast-fallback-frames";
import { pickLeader } from "./broadcast-fallback-frames";

export interface LeaderState {
  leaderId: string | undefined;
  leaderLeaseUntilMs: number;
}

export function createLeaderAnnounceFrame(participantId: string, leaseUntilMs: number): BroadcastLeaderAnnounceFrame {
  return {
    frameType: "leader_announce",
    sourceId: participantId,
    leaderId: participantId,
    leaseUntilMs,
    sentAtMs: Date.now(),
  };
}

export function createLeaderHeartbeatFrame(participantId: string, leaseUntilMs: number): BroadcastLeaderHeartbeatFrame {
  return {
    frameType: "leader_heartbeat",
    sourceId: participantId,
    leaderId: participantId,
    leaseUntilMs,
    sentAtMs: Date.now(),
  };
}

export function createLeaderRetireFrame(participantId: string): BroadcastLeaderRetireFrame {
  return {
    frameType: "leader_retire",
    sourceId: participantId,
    leaderId: participantId,
    sentAtMs: Date.now(),
  };
}

export function electLeaderId(
  participantId: string,
  knownParticipants: Map<string, number>,
  heartbeatTimeoutMs: number,
): string | undefined {
  const now = Date.now();
  knownParticipants.set(participantId, now);

  const alive = Array.from(knownParticipants.entries())
    .filter(([, lastSeenMs]) => now - lastSeenMs <= heartbeatTimeoutMs)
    .map(([id]) => id);

  return pickLeader(alive);
}

export function shouldAdoptLeader(current: LeaderState, frameLeaderId: string, now: number): boolean {
  return (
    !current.leaderId ||
    current.leaderId === frameLeaderId ||
    now >= current.leaderLeaseUntilMs ||
    frameLeaderId.localeCompare(current.leaderId) < 0
  );
}

export function isRetireFrame(frame: BroadcastControlFrame): frame is BroadcastLeaderRetireFrame {
  return frame.frameType === "leader_retire";
}
