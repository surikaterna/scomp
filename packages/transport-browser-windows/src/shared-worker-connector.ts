import type {
  BrowserWindowsSharedWorkerCtor,
  BrowserWindowsSharedWorkerPortLike,
  BrowserWindowsTransportConfig,
} from "./types";

export interface BrowserWindowsSharedWorkerConnector {
  readonly port: BrowserWindowsSharedWorkerPortLike;
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

export function createSharedWorkerConnector(
  config: BrowserWindowsTransportConfig,
): BrowserWindowsSharedWorkerConnector {
  const WorkerCtor = resolveSharedWorkerCtor(config);
  const workerUrl = config.workerUrl ?? "./scomp-browser-windows.worker.js";
  const workerName = config.workerName ?? config.channelName;
  const worker = new WorkerCtor(workerUrl, workerName ? { name: workerName } : undefined);
  const { port } = worker;

  const listeners = new Map<
    (data: unknown) => void,
    (event: { data: unknown }) => void
  >();

  port.start?.();

  return {
    port,
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
