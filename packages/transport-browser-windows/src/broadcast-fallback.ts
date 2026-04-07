import { BrowserWindowsSharedWorkerBroker } from "./shared-worker-broker";
import type { BrowserWindowsProtocolMessage } from "./protocol";
import type {
  BrowserWindowsBroadcastChannelCtor,
  BrowserWindowsBroadcastChannelLike,
  BrowserWindowsTransportConfig,
} from "./types";
import {
  createLeaderAnnounceFrame,
  createLeaderHeartbeatFrame,
  createLeaderRetireFrame,
  electLeaderId,
  isRetireFrame,
  shouldAdoptLeader,
} from "./broadcast-fallback-leader";
import {
  type BroadcastControlFrame,
  type BroadcastFallbackFrame,
  type BroadcastProtocolFrame,
  isBroadcastFallbackFrame,
} from "./broadcast-fallback-frames";
import { BrokerPortLike, InMemoryBrokerPort } from "./broadcast-fallback-port";


export interface BrowserWindowsFallbackConnector {
  addMessageListener(listener: (data: unknown) => void): void;
  removeMessageListener(listener: (data: unknown) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

function isProtocolMessage(value: unknown): value is BrowserWindowsProtocolMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

export function createBroadcastFallbackConnector(
  config: BrowserWindowsTransportConfig,
  participantId: string,
  ChannelCtor: BrowserWindowsBroadcastChannelCtor,
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
    postFrame(createLeaderHeartbeatFrame(participantId, leaderLeaseUntilMs));
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
    postFrame(createLeaderAnnounceFrame(participantId, leaderLeaseUntilMs));
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
    const elected = electLeaderId(
      participantId,
      knownParticipants,
      heartbeatTimeoutMs,
    );
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
    frame: BroadcastControlFrame,
  ): void => {
    knownParticipants.set(frame.sourceId, Date.now());

    if (isRetireFrame(frame)) {
      if (leaderId === frame.leaderId) {
        leaderLeaseUntilMs = 0;
        maybeElectLeader();
      }
      return;
    }

    const now = Date.now();
    if (shouldAdoptLeader({ leaderId, leaderLeaseUntilMs }, frame.leaderId, now)) {
      adoptLeader(frame.leaderId, frame.leaseUntilMs);
    }
  };

  const onChannelMessage = (event: { data: unknown }): void => {
    if (!isBroadcastFallbackFrame(event.data)) {
      return;
    }

    const data = event.data;

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
        postFrame(createLeaderRetireFrame(participantId));
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
