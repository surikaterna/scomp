import type {
  BrowserWindowsTransportHealthListener,
  BrowserWindowsTransportHealthReason,
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthSnapshot,
  BrowserWindowsTransportHealthStatus,
} from "./types";

export interface BrowserWindowsTransportHealthStore {
  snapshot(): BrowserWindowsTransportHealthSnapshot;
  subscribe(listener: BrowserWindowsTransportHealthListener): () => void;
  report(
    code: BrowserWindowsTransportHealthReasonCode,
    detail: string | undefined,
    status: BrowserWindowsTransportHealthStatus,
  ): void;
}

export function createTransportHealthStore(
  initialListener?: BrowserWindowsTransportHealthListener,
): BrowserWindowsTransportHealthStore {
  let current: BrowserWindowsTransportHealthSnapshot = {
    status: "healthy",
    reasons: [],
    updatedAtMs: Date.now(),
  };

  const listeners = new Set<BrowserWindowsTransportHealthListener>();

  const emit = (): void => {
    for (const listener of listeners) {
      listener(current);
    }
  };

  const subscribe = (listener: BrowserWindowsTransportHealthListener): (() => void) => {
    listeners.add(listener);
    listener(current);
    return () => {
      listeners.delete(listener);
    };
  };

  if (initialListener) {
    subscribe(initialListener);
  }

  return {
    snapshot() {
      return current;
    },
    subscribe,
    report(code, detail, status) {
      const atMs = Date.now();
      const existing = current.reasons.find((reason) => reason.code === code);
      const reason: BrowserWindowsTransportHealthReason = {
        code,
        detail,
        atMs,
      };

      const reasons = existing
        ? current.reasons.map((entry) => (entry.code === code ? reason : entry))
        : [...current.reasons, reason];

      current = {
        status,
        reasons,
        updatedAtMs: atMs,
      };
      emit();
    },
  };
}
