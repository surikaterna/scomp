# @scomp/transport-browser-windows

`@scomp/transport-browser-windows` is a same-origin, cross-window browser transport for SCOMP.
It lets tabs/windows in the same origin exchange SCOMP `request`, `signal`, and `feed` traffic.

## What this transport does

- Connects SCOMP participants across browser windows/tabs on the same origin.
- Preserves SCOMP operation semantics (`request`, `signal`, `feed_start`, `feed_stop`).
- Uses a **SharedWorker** message broker when available.
- Falls back to **BroadcastChannel** broker coordination when SharedWorker is unavailable or explicitly disabled.

## Basic usage

```ts
import { createScompClient } from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createBrowserWindowsTransport } from "@scomp/transport-browser-windows";

type CounterApi = {
  counter: {
    get(input: { id: string }): Promise<{ id: string; value: number }>;
  };
};

const transport = createBrowserWindowsTransport({
  channelName: "scomp-app",
  mode: "auto", // default: try SharedWorker first, fallback to BroadcastChannel
});

// In one or more windows that host routes:
const counterService = createScompService<CounterApi["counter"]>("counter").implement({
  requests: {
    get: async ({ id }) => ({ id, value: 1 }),
  },
});
transport.listen(counterService.router);

// In invoking windows:
const client = createScompClient<CounterApi>({ transport });
const result = await client.counter.get({ id: "a" });
console.log(result.value);
```

## Runtime behavior: SharedWorker primary, BroadcastChannel fallback

- `mode: "auto"` (default):
  - Tries SharedWorker first (single broker process per origin/worker URL).
  - Falls back to BroadcastChannel if SharedWorker is unavailable or fails to initialize.
- `mode: "shared-worker"`:
  - Intended SharedWorker-first mode; implementation still degrades to BroadcastChannel when SharedWorker cannot be used in the runtime.
- `mode: "broadcast-channel"`:
  - Forces BroadcastChannel fallback mode.

Use `channelName`, `workerUrl`, and `workerName` to isolate logical clusters when needed.

## SharedWorker script integration (`workerUrl`)

`workerUrl` defaults to `"./scomp-browser-windows.worker.js"`.
That default is a placeholder path, not an auto-hosted worker file. Your app must bundle or host a SharedWorker script and pass its URL.

`@scomp/transport-browser-windows` now provides a concrete worker entry module at:

- `@scomp/transport-browser-windows/src/worker-entry`

Bundle that module as a SharedWorker asset in your app, then pass the emitted URL to `createBrowserWindowsTransport`.

```ts
import {
  DEFAULT_BROWSER_WINDOWS_WORKER_URL,
  createBrowserWindowsTransport,
} from "@scomp/transport-browser-windows";

const workerUrl = new URL(
  "@scomp/transport-browser-windows/src/worker-entry.ts",
  import.meta.url,
);

const transport = createBrowserWindowsTransport({
  channelName: "scomp-app",
  workerUrl: workerUrl.toString(),
});

// Optional: keep using the package default placeholder if your build copies
// the worker to that path.
createBrowserWindowsTransport({
  workerUrl: DEFAULT_BROWSER_WINDOWS_WORKER_URL,
});
```

Exact worker bundling syntax depends on your toolchain (Vite/Webpack/Rollup/Parcel), but the key requirement is:

1. Build/host the worker-entry script as a SharedWorker file.
2. Pass that runtime URL via `workerUrl`.

## Security guidance

This transport is designed for **same-origin trust domains**.

- Treat same-origin windows as the trust boundary for transport-level messaging.
- Do not treat browser transport controls as a server-grade security boundary.
- If identity/authorization is needed, provide `security.authenticate` and `security.authorize` hooks.
- Validate and enforce sensitive auth decisions in trusted backend/server transports.

## Explicit non-goals

- Cross-origin communication.
- Bypassing browser security constraints for restricted APIs.
- Reliable transport during process crashes, hard refresh races, or browser suspension events.
- **Popup/user-gesture transfer orchestration** (for example: using one window’s user gesture to unlock privileged actions in another window) is out of scope.
