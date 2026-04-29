import { BrowserWindowsSharedWorkerBroker, type BrowserWindowsMessagePortLike } from "./shared-worker-broker";

const broker = new BrowserWindowsSharedWorkerBroker();

function isMessagePortLike(port: unknown): port is BrowserWindowsMessagePortLike {
  if (typeof port !== "object" || port === null) {
    return false;
  }

  const candidate = port as {
    postMessage?: unknown;
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };

  return (
    typeof candidate.postMessage === "function" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

type SharedWorkerGlobalLike = {
  onconnect: ((event: { ports?: unknown[] }) => void) | null;
};

const sharedWorkerGlobal = globalThis as unknown as SharedWorkerGlobalLike;

sharedWorkerGlobal.onconnect = (event: { ports?: unknown[] }) => {
  const [port] = event.ports ?? [];
  if (!isMessagePortLike(port)) {
    return;
  }

  broker.attachPort(port);
};
