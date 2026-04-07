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

- `mode: "auto"` (default): tries SharedWorker first, then BroadcastChannel fallback.
- `mode: "shared-worker"`: SharedWorker-first. By default it can fall back to BroadcastChannel.
- `mode: "broadcast-channel"`: forces BroadcastChannel and never attempts SharedWorker.

### Deterministic mode resolution matrix

| `mode` | SharedWorker available | BroadcastChannel available | `sharedWorkerStrict` | Result |
| --- | --- | --- | --- | --- |
| `auto` | yes | yes/no | n/a | uses `shared-worker` |
| `auto` | no | yes | n/a | falls back to `broadcast-channel` (degraded health: `shared-worker-unavailable`) |
| `auto` | no | no | n/a | throws `broadcast-channel-unavailable` |
| `shared-worker` | yes | yes/no | `false` (default) | uses `shared-worker` |
| `shared-worker` | no | yes | `false` (default) | falls back to `broadcast-channel` (degraded health: `shared-worker-unavailable`) |
| `shared-worker` | no | yes/no | `true` | fail-fast with `shared-worker-unavailable` |
| `shared-worker` | no | no | `false` (default) | throws `broadcast-channel-unavailable` |
| `broadcast-channel` | yes/no | yes | n/a | uses `broadcast-channel` |
| `broadcast-channel` | yes/no | no | n/a | throws `broadcast-channel-unavailable` |

Set `sharedWorkerStrict: true` to make `mode: "shared-worker"` fail fast instead of allowing fallback.

Use `channelName`, `workerUrl`, and `workerName` to isolate logical clusters when needed.

## Strict route-intent safety (optional)

By default, outbound invocations are backward-compatible and do not enforce a route allowlist.

Set `strictRouteIntents: true` to fail fast **before send** when:

- a route is missing from `routeIntents`
- operation kind does not match (`request`/`signal`/`feed_start|feed_stop`)

```ts
const transport = createBrowserWindowsTransport({
  strictRouteIntents: true,
  routeIntents: {
    "counter.get": "request",
    "counter.notify": "signal",
    "counter.watch": "feed",
  },
});
```

### Ergonomic helper from compiled router metadata

Use helper utilities to derive route intents from compiled route maps and avoid manual drift:

```ts
import { createScompService } from "@scomp/core";
import {
  createBrowserWindowsTransport,
  createRouteIntentsFromCompiledRouter,
} from "@scomp/transport-browser-windows";

const counterService = createScompService<{ get(input: { id: string }): Promise<{ id: string }> }>(
  "counter",
).implement({
  requests: {
    get: async ({ id }) => ({ id }),
  },
});

const routeIntents = createRouteIntentsFromCompiledRouter(counterService.router);

const transport = createBrowserWindowsTransport({
  strictRouteIntents: true,
  routeIntents,
});
```

For multi-service setup, merge intents from many routers with `createRouteIntentsFromCompiledRouters([...])`.

## Health snapshots and degraded reason taxonomy

The transport can emit runtime health snapshots for observability and alerting:

```ts
const transport = createBrowserWindowsTransport({
  health: {
    onSnapshot(snapshot) {
      // Called immediately with initial snapshot, then on transitions.
      console.log(snapshot.status, snapshot.reasons);
    },
  },
});

const unsubscribe = transport.subscribeHealth((snapshot) => {
  console.log(snapshot.updatedAtMs);
});

const now = transport.healthSnapshot();
unsubscribe();
```

You can also read the currently selected runtime mode directly:

```ts
const mode = transport.activeMode();
const snapshotMode = transport.healthSnapshot().activeMode;
```

Snapshot status model:

- `healthy`
- `degraded`
- `unavailable`

Reason codes are machine-readable and stable:

- `shared-worker-unavailable`
- `broadcast-channel-unavailable`
- `leader-failover`
- `host-disconnected`
- `auth-denied`
- `request-timeout`
- `publish-failed`

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
