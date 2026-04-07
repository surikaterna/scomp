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
