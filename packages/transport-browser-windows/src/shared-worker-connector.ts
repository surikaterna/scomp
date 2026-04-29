import type {
  BrowserWindowsBroadcastChannelCtor,
  BrowserWindowsSharedWorkerCtor,
  BrowserWindowsTransportConfig,
  BrowserWindowsTransportMode,
} from "./types";
import { createBroadcastFallbackConnector, type BrowserWindowsFallbackRuntimeEvent } from "./broadcast-fallback";
import { DEFAULT_BROWSER_WINDOWS_WORKER_URL } from "./worker-url";
import { toErrorMessage, toUnavailableDetail } from "./shared-worker-connector-errors";

export interface BrowserWindowsRuntimeConnector {
  readonly activeMode: BrowserWindowsTransportMode;
  addMessageListener(listener: (data: unknown) => void): void;
  removeMessageListener(listener: (data: unknown) => void): void;
  addRuntimeEventListener?(listener: (event: BrowserWindowsRuntimeEvent) => void): void;
  removeRuntimeEventListener?(listener: (event: BrowserWindowsRuntimeEvent) => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

export type BrowserWindowsRuntimeEvent =
  | BrowserWindowsFallbackRuntimeEvent
  | {
      type: "active-mode-changed";
      mode: BrowserWindowsTransportMode;
      atMs: number;
    }
  | {
      type: "shared-worker-unavailable";
      detail: string;
      atMs: number;
    }
  | {
      type: "broadcast-channel-unavailable";
      detail: string;
      atMs: number;
    };

function resolveSharedWorkerCtor(config: BrowserWindowsTransportConfig): BrowserWindowsSharedWorkerCtor {
  if (config.sharedWorkerCtor) {
    return config.sharedWorkerCtor;
  }

  const ctor = (globalThis as { SharedWorker?: BrowserWindowsSharedWorkerCtor }).SharedWorker;
  if (!ctor) {
    throw new Error("SharedWorker is not available in this runtime.");
  }

  return ctor;
}

function resolveBroadcastChannelCtor(config: BrowserWindowsTransportConfig): BrowserWindowsBroadcastChannelCtor {
  if (config.broadcastChannelCtor) {
    return config.broadcastChannelCtor;
  }

  const ctor = (globalThis as { BroadcastChannel?: BrowserWindowsBroadcastChannelCtor }).BroadcastChannel;
  if (!ctor) {
    throw new Error("BroadcastChannel is not available in this runtime.");
  }

  return ctor;
}

export function createSharedWorkerConnector(config: BrowserWindowsTransportConfig): BrowserWindowsRuntimeConnector {
  const WorkerCtor = resolveSharedWorkerCtor(config);
  const workerUrl = config.workerUrl ?? DEFAULT_BROWSER_WINDOWS_WORKER_URL;
  const workerName = config.workerName ?? config.channelName;
  const worker = new WorkerCtor(workerUrl, workerName ? { name: workerName } : undefined);
  const { port } = worker;

  const listeners = new Map<(data: unknown) => void, (event: { data: unknown }) => void>();

  port.start?.();

  return {
    activeMode: "shared-worker",
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

function createBroadcastChannelConnector(
  config: BrowserWindowsTransportConfig,
  participantId: string,
): BrowserWindowsRuntimeConnector {
  const ChannelCtor = resolveBroadcastChannelCtor(config);
  return createBroadcastFallbackConnector(config, participantId, ChannelCtor);
}

function withInitialRuntimeEvent(
  connector: BrowserWindowsRuntimeConnector,
  initialEvents: ReadonlyArray<BrowserWindowsRuntimeEvent>,
): BrowserWindowsRuntimeConnector {
  return {
    activeMode: connector.activeMode,
    addMessageListener(listener) {
      connector.addMessageListener(listener);
    },
    removeMessageListener(listener) {
      connector.removeMessageListener(listener);
    },
    addRuntimeEventListener(listener) {
      for (const event of initialEvents) {
        listener(event);
      }
      connector.addRuntimeEventListener?.(listener);
    },
    removeRuntimeEventListener(listener) {
      connector.removeRuntimeEventListener?.(listener);
    },
    postMessage(message) {
      connector.postMessage(message);
    },
    close() {
      connector.close();
    },
  };
}

function resolveModePreference(config: BrowserWindowsTransportConfig): "auto" | BrowserWindowsTransportMode {
  return config.mode ?? "auto";
}

function strictSharedWorkerMode(config: BrowserWindowsTransportConfig): boolean {
  return config.sharedWorkerStrict === true;
}

export function createRuntimeConnector(
  config: BrowserWindowsTransportConfig,
  participantId: string,
): BrowserWindowsRuntimeConnector {
  const modePreference = resolveModePreference(config);

  if (modePreference === "broadcast-channel") {
    try {
      return createBroadcastChannelConnector(config, participantId);
    } catch (error) {
      const detail = toErrorMessage(error, "BroadcastChannel initialization failed.");
      throw new Error(toUnavailableDetail("broadcast-channel-unavailable", detail));
    }
  }

  try {
    return createSharedWorkerConnector(config);
  } catch (error) {
    const sharedWorkerDetail = toErrorMessage(error, "SharedWorker initialization failed.");

    if (modePreference === "shared-worker" && strictSharedWorkerMode(config)) {
      throw new Error(toUnavailableDetail("shared-worker-unavailable", sharedWorkerDetail));
    }

    try {
      const fallbackConnector = createBroadcastChannelConnector(config, participantId);
      const fallbackAtMs = Date.now();

      return withInitialRuntimeEvent(fallbackConnector, [
        {
          type: "shared-worker-unavailable",
          detail: sharedWorkerDetail,
          atMs: fallbackAtMs,
        },
        {
          type: "active-mode-changed",
          mode: "broadcast-channel",
          atMs: fallbackAtMs,
        },
      ]);
    } catch (broadcastError) {
      const broadcastDetail = toErrorMessage(broadcastError, "BroadcastChannel fallback initialization failed.");

      throw new Error(
        toUnavailableDetail(
          "broadcast-channel-unavailable",
          `SharedWorker failed (${sharedWorkerDetail}); fallback failed (${broadcastDetail})`,
        ),
      );
    }
  }
}
