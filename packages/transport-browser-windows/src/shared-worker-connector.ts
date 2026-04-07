import type {
  BrowserWindowsBroadcastChannelCtor,
  BrowserWindowsBroadcastChannelLike,
  BrowserWindowsSharedWorkerCtor,
  BrowserWindowsTransportConfig,
} from "./types";
import {
  createBroadcastFallbackConnector,
  type BrowserWindowsFallbackConnector,
} from "./broadcast-fallback";
import { DEFAULT_BROWSER_WINDOWS_WORKER_URL } from "./worker-url";

export interface BrowserWindowsRuntimeConnector {
  addMessageListener(listener: (data: unknown) => void): void;
  removeMessageListener(listener: (data: unknown) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

function resolveSharedWorkerCtor(
  config: BrowserWindowsTransportConfig,
): BrowserWindowsSharedWorkerCtor {
  if (config.sharedWorkerCtor) {
    return config.sharedWorkerCtor;
  }

  const ctor = (globalThis as { SharedWorker?: BrowserWindowsSharedWorkerCtor })
    .SharedWorker;
  if (!ctor) {
    throw new Error("SharedWorker is not available in this runtime.");
  }

  return ctor;
}

function resolveBroadcastChannelCtor(
  config: BrowserWindowsTransportConfig,
): BrowserWindowsBroadcastChannelCtor {
  if (config.broadcastChannelCtor) {
    return config.broadcastChannelCtor;
  }

  const ctor = (globalThis as { BroadcastChannel?: BrowserWindowsBroadcastChannelCtor })
    .BroadcastChannel;
  if (!ctor) {
    throw new Error("BroadcastChannel is not available in this runtime.");
  }

  return ctor;
}

export function createSharedWorkerConnector(
  config: BrowserWindowsTransportConfig,
): BrowserWindowsRuntimeConnector {
  const WorkerCtor = resolveSharedWorkerCtor(config);
  const workerUrl = config.workerUrl ?? DEFAULT_BROWSER_WINDOWS_WORKER_URL;
  const workerName = config.workerName ?? config.channelName;
  const worker = new WorkerCtor(workerUrl, workerName ? { name: workerName } : undefined);
  const { port } = worker;

  const listeners = new Map<
    (data: unknown) => void,
    (event: { data: unknown }) => void
  >();

  port.start?.();

  return {
    addMessageListener(listener) {
      const wrapped = (event: { data: unknown }) => {
        listener(event.data);
      };
      listeners.set(listener, wrapped);
      port.addEventListener("message", wrapped);
    },
    removeMessageListener(listener) {
      const wrapped = listeners.get(listener);
      if (!wrapped) {
        return;
      }

      listeners.delete(listener);
      port.removeEventListener("message", wrapped);
    },
    postMessage(message) {
      port.postMessage(message);
    },
    close() {
      for (const wrapped of listeners.values()) {
        port.removeEventListener("message", wrapped);
      }
      listeners.clear();
      port.close?.();
    },
  };
}

function shouldUseBroadcastFallback(config: BrowserWindowsTransportConfig): boolean {
  return config.mode === "broadcast-channel";
}

export function createRuntimeConnector(
  config: BrowserWindowsTransportConfig,
  participantId: string,
): BrowserWindowsRuntimeConnector {
  if (shouldUseBroadcastFallback(config)) {
    const ChannelCtor = resolveBroadcastChannelCtor(config);
    return createBroadcastFallbackConnector(config, participantId, ChannelCtor);
  }

  try {
    return createSharedWorkerConnector(config);
  } catch {
    const ChannelCtor = resolveBroadcastChannelCtor(config);
    return createBroadcastFallbackConnector(
      config,
      participantId,
      ChannelCtor,
    );
  }
}

export type { BrowserWindowsFallbackConnector };
