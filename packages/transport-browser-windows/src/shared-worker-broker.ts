import type { BrowserWindowsProtocolMessage } from "./protocol";
import { type BrokerContext, createBrokerState } from "./shared-worker-broker-context";
import { cleanupDisconnectedParticipant } from "./shared-worker-broker-disconnect";
import {
  handleHostFeedChunk,
  handleHostFeedStarted,
  handleHostResponse,
  handleInvokeFeedStart,
  handleInvokeFeedStop,
  handleInvokeRequest,
  handleInvokeSignal,
} from "./shared-worker-broker-dispatch";
import { registerRoutes, unregisterRoutes } from "./shared-worker-broker-routes";
import type { BrowserWindowsParticipantId } from "./types";

export interface BrowserWindowsMessagePortLike {
  postMessage(message: BrowserWindowsProtocolMessage): void;
  addEventListener(type: "message", listener: (event: { data: BrowserWindowsProtocolMessage }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: BrowserWindowsProtocolMessage }) => void): void;
  start?(): void;
}

export class BrowserWindowsSharedWorkerBroker {
  private readonly context: BrokerContext = {
    state: createBrokerState(),
    portsByParticipant: new Map(),
    routesByParticipant: new Map(),
    sendToParticipant: (participantId, message) => {
      const port = this.context.portsByParticipant.get(participantId);
      if (!port) {
        return;
      }

      this.context.sendTo(port, message);
    },
    sendTo: (port, message) => {
      port.postMessage(message);
    },
  };

  attachPort(port: BrowserWindowsMessagePortLike): void {
    const listener = (event: { data: BrowserWindowsProtocolMessage }) => {
      this.handleMessage(port, event.data);
    };

    port.addEventListener("message", listener);
    port.start?.();
  }

  disconnectParticipant(participantId: BrowserWindowsParticipantId): void {
    this.context.portsByParticipant.delete(participantId);
    cleanupDisconnectedParticipant(this.context, participantId);
  }

  private handleMessage(sourcePort: BrowserWindowsMessagePortLike, message: BrowserWindowsProtocolMessage): void {
    if (!message?.sourceId) {
      return;
    }

    this.context.portsByParticipant.set(message.sourceId, sourcePort);

    switch (message.type) {
      case "hello":
        this.context.sendTo(sourcePort, {
          type: "hello_ack",
          sourceId: "broker",
          targetId: message.sourceId,
          sentAtMs: Date.now(),
          meta: message.meta,
        });
        return;
      case "routes_register":
        registerRoutes(this.context, message.sourceId, message.routes);
        return;
      case "routes_unregister":
        unregisterRoutes(this.context, message.sourceId, message.routes);
        return;
      case "participant_disconnect":
        cleanupDisconnectedParticipant(this.context, message.sourceId);
        this.context.portsByParticipant.delete(message.sourceId);
        return;
      case "invoke_request":
        handleInvokeRequest(this.context, message);
        return;
      case "invoke_signal":
        handleInvokeSignal(this.context, message);
        return;
      case "invoke_feed_start":
        handleInvokeFeedStart(this.context, message);
        return;
      case "invoke_feed_stop":
        handleInvokeFeedStop(this.context, message);
        return;
      case "host_response":
        handleHostResponse(this.context, message);
        return;
      case "host_feed_started":
        handleHostFeedStarted(this.context, message);
        return;
      case "host_feed_chunk":
        handleHostFeedChunk(this.context, message);
        return;
      case "heartbeat":
      case "hello_ack":
      case "invoke_feed_chunk":
        if (message.targetId) {
          this.context.sendToParticipant(message.targetId, message);
        }
        return;
      case "host_request":
      case "host_signal":
      case "host_feed_start":
      case "host_feed_stop":
      case "invoke_response":
        return;
      default:
        return;
    }
  }
}
