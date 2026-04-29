/**
 * Standalone reconnection utility with exponential backoff and jitter.
 *
 * Designed to be transport-agnostic — the caller supplies the connect
 * function and the abort signal.
 */

import type { WebSocketReconnectConfig, WebSocketTransportEvent } from "./client-types";

export interface ReconnectOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onAttempt?: (attempt: number) => void;
  onFailure?: (attempts: number, error: unknown) => void;
  signal?: AbortSignal;
}

export async function reconnectWithBackoff<T>(tryConnect: () => Promise<T>, options: ReconnectOptions): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new Error("Reconnect aborted");

    options.onAttempt?.(attempt);

    const jitter = Math.floor(Math.random() * 100);
    const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1) + jitter);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    if (options.signal?.aborted) throw new Error("Reconnect aborted");

    try {
      return await tryConnect();
    } catch (error) {
      lastError = error;
    }
  }

  options.onFailure?.(options.maxAttempts, lastError);
  throw lastError;
}

// ---------------------------------------------------------------------------
// Transport-level reconnect orchestration
// ---------------------------------------------------------------------------

export interface ReconnectLoopDeps<T> {
  cfg: WebSocketReconnectConfig;
  connect: () => Promise<T>;
  onConnected: (result: T) => void;
  emitEvent: (event: WebSocketTransportEvent) => void;
  signal: AbortSignal;
}

/**
 * Runs a full reconnect loop using the backoff utility, wiring events
 * and invoking the `onConnected` callback on success.
 *
 * Returns a promise that settles when reconnection succeeds or exhausts
 * all attempts (resolves `undefined` on failure — never throws).
 */
export async function runReconnectLoop<T>(deps: ReconnectLoopDeps<T>): Promise<T | undefined> {
  try {
    const result = await reconnectWithBackoff(deps.connect, {
      maxAttempts: deps.cfg.maxAttempts ?? 6,
      baseDelayMs: deps.cfg.baseDelayMs ?? 250,
      maxDelayMs: deps.cfg.maxDelayMs ?? 8_000,
      onAttempt: (attempt) => deps.emitEvent({ type: "connection_reconnect", attempt }),
      onFailure: (attempts, err) =>
        deps.emitEvent({
          type: "connection_reconnect_failed",
          attempts,
          error: err instanceof Error ? err.message : String(err),
        }),
      signal: deps.signal,
    });
    deps.onConnected(result);
    return result;
  } catch {
    return undefined;
  }
}
