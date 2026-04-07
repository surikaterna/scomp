# SCOMP

SCOMP is a transport-agnostic RPC toolkit with first-class `request`, `signal`, and `feed` semantics.

Typed service contract + transport toolkit.

## Default authoring model (strict + grouped)

SCOMP defaults to **strict, grouped service authoring** with three operation sections:

- `requests`
- `signals`
- `feeds`

Use `createScompService` to define a full service. In strict mode, every contract method must be implemented and grouped under the correct section.

```ts
import { createScompService } from '@scomp/core';

interface UsersContract {
  getUser(input: { id: number }): Promise<{ id: number; name: string }>;
  notifyLogin(input: { id: number; at: string }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

const usersService = createScompService<UsersContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id, name: `user-${id}` })
  },
  signals: {
    notifyLogin: async ({ id, at }) => {
      console.log('login', { id, at });
    }
  },
  feeds: {
    liveUsers: {
      strategy: 'fanout',
      handler: async function* () {
        yield { id: 1 };
      }
    }
  }
});
```

## Fragment composition flow

Use **fragments** for partial/domain-local implementation, then compose them with `composeScompFragments`.

```ts
import { createScompFragment, composeScompFragments } from '@scomp/core';

const usersRequests = createScompFragment<UsersContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id, name: `user-${id}` })
  }
});

const usersSignals = createScompFragment<UsersContract>('users').implement({
  signals: {
    notifyLogin: async () => {
      return;
    }
  }
});

const usersFeeds = createScompFragment<UsersContract>('users').implement({
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    }
  }
});

const usersRouterFragment = composeScompFragments(usersRequests, usersSignals, usersFeeds);
```

Fragment composition rejects duplicate methods across fragments.

## Packages

- `@scomp/client` – typed client proxy API with per-call invocation options.
- `@scomp/core` – service/router primitives.
- `@scomp/transport-rabbitmq` – RabbitMQ transport.
- `@scomp/transport-browser-windows` – same-origin browser tab/window transport (SharedWorker primary, BroadcastChannel fallback).
- `@scomp/transport-websocket-server` – WebSocket server transport for hosting routes.
- `@scomp/transport-websocket-server-node` – Node (`ws` + `http`) WebSocket server transport.
- `@scomp/transport-websocket-browser` – browser WebSocket client transport.

## WebSocket server package split (Bun vs Node)

The websocket server transport is split by runtime:

- **Bun runtime (`Bun.serve`)**: `@scomp/transport-websocket-server`
- **Node runtime (`ws` + `http`)**: `@scomp/transport-websocket-server-node`

If you previously imported Node server transport from `@scomp/transport-websocket-server`,
switch those imports to `@scomp/transport-websocket-server-node`.

See migration notes: [docs/migration-websocket-server-split.md](docs/migration-websocket-server-split.md)

## Browser transport quickstart and parity

Use `@scomp/transport-websocket-browser` in browser-like runtimes and pair it with a server transport (for example `@scomp/transport-websocket-server`) that hosts routes.

```ts
import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createWebSocketBrowserTransport } from "@scomp/transport-websocket-browser";

type ApiContract = {
  users: {
    getUser(input: { id: number }): Promise<{ id: number; name: string }>;
    notifyLogin(input: { userId: number; at: string }): Promise<void>;
    liveTicker(input: { channel: string }): AsyncIterable<{ sequence: number }>;
  };
};

const routeHints: ClientRouteHints = {
  "users.getUser": "request",
  "users.notifyLogin": "signal",
  "users.liveTicker": "feed",
};

const transport = createWebSocketBrowserTransport({
  url: "ws://127.0.0.1:3399",
  meta: {
    traceId: "browser-trace",
    tags: { source: "browser" },
  },
});

const client = createScompClient<ApiContract>({ transport, routeHints });

const user = await client.users.getUser(
  { id: 1 },
  {
    meta: { tenantId: "tenant-a" },
    priority: "P1",
    priorityClass: "P2",
    deadlineAtMs: Date.now() + 1_000,
    targetLatencyMs: 40,
  },
);

await client.users.notifyLogin({ userId: user.id, at: new Date().toISOString() });

for await (const tick of client.users.liveTicker({ channel: "prices" })) {
  console.log(tick);
  break;
}
```

## Browser parity guarantees

`@scomp/transport-websocket-browser` now matches server/client transports for invocation envelope behavior:

- `request`, `signal`, `feed_start`, and `feed_stop` all carry invocation options.
- Metadata merge order is deterministic: `config.meta` -> `call meta` -> priority hints -> authenticated principal metadata.
- Priority hints (`priority`, `priorityClass`, `deadlineAtMs`, `targetLatencyMs`) are serialized into envelope `meta`.
- Feed stop uses the same metadata shape as feed start when invoked from the same call context.

## Security behavior and caveats

Both browser and WebSocket server transports support `security.authenticate` and `security.authorize` hooks.

- Browser transport hooks run before sending outbound envelopes.
- Server transport hooks run for inbound envelopes before route dispatch.
- If authorization denies an operation, the operation is rejected and no outbound frame is sent (browser client behavior).

Important caveats:

- Browser-side hooks are best-effort client policy controls, not a trust boundary.
- `meta.auth` is opaque and transport-agnostic; verify and enforce identity server-side.
- Priority hints are advisory metadata unless a transport/policy explicitly enforces scheduling behavior.

## Migration notes (browser websocket)

If you were using browser WebSocket transport before parity updates, align to the following:

1. Depend on `@scomp/transport-websocket-browser` for browser clients.
2. Pass invocation options on client calls when needed:
   - `meta`
   - `priority`
   - `priorityClass`
   - `deadlineAtMs`
   - `targetLatencyMs`
3. Expect these options to be present on request/signal/feed envelopes.
4. Keep authorization and identity enforcement on trusted server-side transports.

## Demo

RabbitMQ demo entrypoint (existing):

- `bun run --filter='@scomp/demo' start`

Browser parity demo entrypoint:

- `bun run --filter='@scomp/demo' run-browser`

The browser demo uses WebSocket server + browser transport in one process and showcases request/signal/feed parity including metadata, priority hints, and security hooks.

## Protocol reference

- [docs/transport-json-protocol.md](docs/transport-json-protocol.md)
