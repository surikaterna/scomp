import { BrowserWindowsSharedWorkerBroker } from "./shared-worker-broker";
import type { BrowserWindowsProtocolMessage } from "./protocol";
import type {
  BrowserWindowsBroadcastChannelCtor,
  BrowserWindowsBroadcastChannelLike,
  BrowserWindowsTransportConfig,
} from "./types";

interface BroadcastProtocolFrame {
  frameType: "protocol";
  sourceId: string;
  message: BrowserWindowsProtocolMessage;
}

interface BroadcastLeaderHeartbeatFrame {
  frameType: "leader_heartbeat";
  sourceId: string;
  leaderId: string;
  leaseUntilMs: number;
  sentAtMs: number;
}

interface BroadcastLeaderAnnounceFrame {
  frameType: "leader_announce";
  sourceId: string;
  leaderId: string;
  leaseUntilMs: number;
  sentAtMs: number;
}

interface BroadcastLeaderRetireFrame {
  frameType: "leader_retire";
  sourceId: string;
  leaderId: string;
  sentAtMs: number;
}

type BroadcastFallbackFrame =
  | BroadcastProtocolFrame
  | BroadcastLeaderHeartbeatFrame
  | BroadcastLeaderAnnounceFrame
  | BroadcastLeaderRetireFrame;

interface BrokerPortLike {
  postMessage(message: BrowserWindowsProtocolMessage): void;
  addEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  start?(): void;
  emitIncoming(message: BrowserWindowsProtocolMessage): void;
}

class InMemoryBrokerPort implements BrokerPortLike {
  private readonly listeners = new Set<
    (event: { data: BrowserWindowsProtocolMessage }) => void
  >();

  constructor(
    private readonly sender: (message: BrowserWindowsProtocolMessage) => void,
  ) {}

  postMessage(message: BrowserWindowsProtocolMessage): void {
    this.sender(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  start(): void {
    // no-op
  }

  emitIncoming(message: BrowserWindowsProtocolMessage): void {
    for (const listener of this.listeners) {
      listener({ data: message });
    }
  }
}

export interface BrowserWindowsFallbackConnector {
  addMessageListener(listener: (data: unknown) => void): void;
  removeMessageListener(listener: (data: unknown) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

function isProtocolMessage(value: unknown): value is BrowserWindowsProtocolMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

function pickLeader(participants: Array<string>): string | undefined {
  if (participants.length === 0) {
    return undefined;
  }

  const sorted = [...participants].sort((a, b) => a.localeCompare(b));
  return sorted[0];
}

export function createBroadcastFallbackConnector(
  config: BrowserWindowsTransportConfig,
  participantId: string,
  ChannelCtor: BrowserWindowsBroadcastChannelCtor,
  _sharedWorkerError?: Error,
): BrowserWindowsFallbackConnector {
  const channelName = config.channelName ?? "scomp-browser-windows";
  const channel: BrowserWindowsBroadcastChannelLike = new ChannelCtor(channelName);
  const listeners = new Set<(data: unknown) => void>();
  const knownParticipants = new Map<string, number>();
  const routes = new Set<string>();
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 250;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 1000;
  const participantPorts = new Map<string, BrokerPortLike>();

  let broker: BrowserWindowsSharedWorkerBroker | undefined;
  let localPort: BrokerPortLike | undefined;
  let leaderId: string | undefined;
  let leaderLeaseUntilMs = 0;
  let closed = false;

  const emitLocal = (message: BrowserWindowsProtocolMessage): void => {
    queueMicrotask(() => {
      for (const listener of listeners) {
        listener(message);
      }
    });
  };

  const postFrame = (frame: BroadcastFallbackFrame): void => {
    channel.postMessage(frame);
  };

  const ensureLeaderBroker = (): void => {
    if (broker && localPort) {
      return;
    }

    broker = new BrowserWindowsSharedWorkerBroker();
    localPort = new InMemoryBrokerPort((message) => {
      emitLocal(message);
    });
    broker.attachPort(localPort);
  };

  const broadcastHeartbeat = (): void => {
    if (leaderId !== participantId) {
      return;
    }

    leaderLeaseUntilMs = Date.now() + heartbeatTimeoutMs;
    postFrame({
      frameType: "leader_heartbeat",
      sourceId: participantId,
      leaderId: participantId,
      leaseUntilMs: leaderLeaseUntilMs,
      sentAtMs: Date.now(),
    });
  };

  const syncLocalStateToBroker = (): void => {
    const now = Date.now();
    const hello: BrowserWindowsProtocolMessage = {
      type: "hello",
      sourceId: participantId,
      sentAtMs: now,
    };

    if (leaderId === participantId && broker && localPort) {
      localPort.emitIncoming(hello);
    } else {
      postFrame({ frameType: "protocol", sourceId: participantId, message: hello });
    }

    if (routes.size === 0) {
      return;
    }

    const register: BrowserWindowsProtocolMessage = {
      type: "routes_register",
      sourceId: participantId,
      sentAtMs: now,
      routes: Array.from(routes),
    };

    if (leaderId === participantId && broker && localPort) {
      localPort.emitIncoming(register);
    } else {
      postFrame({ frameType: "protocol", sourceId: participantId, message: register });
    }
  };

  const becomeLeader = (): void => {
    ensureLeaderBroker();
    leaderId = participantId;
    leaderLeaseUntilMs = Date.now() + heartbeatTimeoutMs;
    postFrame({
      frameType: "leader_announce",
      sourceId: participantId,
      leaderId: participantId,
      leaseUntilMs: leaderLeaseUntilMs,
      sentAtMs: Date.now(),
    });
    broadcastHeartbeat();
    syncLocalStateToBroker();
  };

  const stepDown = (): void => {
    broker = undefined;
    localPort = undefined;
    participantPorts.clear();
  };

  const adoptLeader = (nextLeaderId: string, leaseUntilMs: number): void => {
    const changed = leaderId !== nextLeaderId;
    if (nextLeaderId !== participantId && leaderId === participantId) {
      stepDown();
    }

    leaderId = nextLeaderId;
    leaderLeaseUntilMs = leaseUntilMs;
    if (changed && nextLeaderId !== participantId) {
      syncLocalStateToBroker();
    }
  };

  const maybeElectLeader = (): void => {
    const now = Date.now();
    knownParticipants.set(participantId, now);

    const alive = Array.from(knownParticipants.entries())
      .filter(([, lastSeenMs]) => now - lastSeenMs <= heartbeatTimeoutMs)
      .map(([id]) => id);

    const elected = pickLeader(alive);
    if (!elected) {
      return;
    }

    if (elected === participantId) {
      if (leaderId !== participantId || now >= leaderLeaseUntilMs) {
        becomeLeader();
      }
      return;
    }

    if (!leaderId || now >= leaderLeaseUntilMs || elected.localeCompare(leaderId) < 0) {
      adoptLeader(elected, now + heartbeatTimeoutMs);
    }
  };

  const ensureParticipantPort = (id: string): BrokerPortLike => {
    const existing = participantPorts.get(id);
    if (existing) {
      return existing;
    }

    const port = new InMemoryBrokerPort((message) => {
      postFrame({
        frameType: "protocol",
        sourceId: participantId,
        message,
      });
    });

    participantPorts.set(id, port);
    broker?.attachPort(port);
    return port;
  };

  const onProtocolFrame = (frame: BroadcastProtocolFrame): void => {
    knownParticipants.set(frame.sourceId, Date.now());

    if (leaderId === participantId && broker) {
      const port = frame.sourceId === participantId ? localPort : ensureParticipantPort(frame.sourceId);
      port?.emitIncoming(frame.message);
      return;
    }

    const targetId = frame.message.targetId;
    if (!targetId || targetId === participantId) {
      emitLocal(frame.message);
    }
  };

  const onControlFrame = (
    frame:
      | BroadcastLeaderHeartbeatFrame
      | BroadcastLeaderAnnounceFrame
      | BroadcastLeaderRetireFrame,
  ): void => {
    knownParticipants.set(frame.sourceId, Date.now());

    if (frame.frameType === "leader_retire") {
      if (leaderId === frame.leaderId) {
        leaderLeaseUntilMs = 0;
        maybeElectLeader();
      }
      return;
    }

    const now = Date.now();
    if (
      !leaderId ||
      leaderId === frame.leaderId ||
      now >= leaderLeaseUntilMs ||
      frame.leaderId.localeCompare(leaderId) < 0
    ) {
      adoptLeader(frame.leaderId, frame.leaseUntilMs);
    }
  };

  const onChannelMessage = (event: { data: unknown }): void => {
    const data = event.data as BroadcastFallbackFrame | undefined;
    if (!data || typeof data !== "object" || !("frameType" in data)) {
      return;
    }

    switch (data.frameType) {
      case "protocol":
        onProtocolFrame(data);
        return;
      case "leader_announce":
      case "leader_heartbeat":
      case "leader_retire":
        onControlFrame(data);
        return;
      default:
        return;
    }
  };

  const interval = setInterval(() => {
    if (closed) {
      return;
    }

    const now = Date.now();
    knownParticipants.set(participantId, now);
    for (const [id, lastSeenMs] of knownParticipants.entries()) {
      if (now - lastSeenMs > heartbeatTimeoutMs * 2) {
        knownParticipants.delete(id);
      }
    }

    if (leaderId === participantId) {
      broadcastHeartbeat();
      return;
    }

    if (!leaderId || now >= leaderLeaseUntilMs) {
      maybeElectLeader();
    }
  }, heartbeatIntervalMs);

  channel.addEventListener("message", onChannelMessage);
  knownParticipants.set(participantId, Date.now());
  maybeElectLeader();
  syncLocalStateToBroker();

  return {
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    postMessage(message) {
      if (!isProtocolMessage(message)) {
        return;
      }

      if (message.type === "routes_register") {
        for (const route of message.routes) {
          routes.add(route);
        }
      }

      if (message.type === "routes_unregister") {
        for (const route of message.routes) {
          routes.delete(route);
        }
      }

      if (leaderId === participantId && broker && localPort) {
        localPort.emitIncoming(message);
        return;
      }

      postFrame({ frameType: "protocol", sourceId: participantId, message });
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(interval);

      if (leaderId === participantId) {
        postFrame({
          frameType: "leader_retire",
          sourceId: participantId,
          leaderId: participantId,
          sentAtMs: Date.now(),
        });
      }

      if (broker && leaderId === participantId) {
        broker.disconnectParticipant(participantId);
      }

      listeners.clear();
      participantPorts.clear();
      channel.removeEventListener("message", onChannelMessage);
      channel.close();
      stepDown();
      leaderId = undefined;
      leaderLeaseUntilMs = 0;
    },
  };
}
