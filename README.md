# SCOMP

SCOMP is a transport-agnostic RPC toolkit with first-class `request`, `signal`, and `feed` semantics.

Typed service contracts bound to runtime tokens. Symmetric peer model. Controlled feeds with typed controllers.

## LLM/contributor guides

- [llms.txt](llms.txt) — practical SCOMP mental model, modern API usage, transport matrix, security caveats, and common mistakes.
- [docs/llms-transports.md](docs/llms-transports.md) — concise runnable transport setup patterns.

## Validation commands

```bash
bunx turbo run build    # build all packages
bunx turbo run test     # run all tests
bunx turbo run lint     # lint all packages
```

## Core concepts

### Contract tokens

A contract token binds a TypeScript contract type to a service name at runtime:

```ts
import { createContractToken } from "@scomp/core";

type UsersContract = {
  getUser(input: { id: number }): Promise<{ id: number; name: string }>;
  notifyLogin(input: { id: number; at: string }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
};

const Users = createContractToken<UsersContract>("users");
```

### Peer model

A peer is a symmetric node that can host services and/or call remote services:

```ts
import { createScompPeer, createScompService } from "@scomp/core";

const peer = createScompPeer({ transports: [transport] });

// Host a service
peer.provides(
  createScompService(Users).implement({
    requests: {
      getUser: async ({ id }) => ({ id, name: `user-${id}` }),
    },
    signals: {
      notifyLogin: async ({ id, at }) => {
        console.log("login", { id, at });
      },
    },
    feeds: {
      liveUsers: {
        strategy: "fanout",
        handler: async function* () {
          yield { id: 1 };
        },
      },
    },
  }),
);

// Call a remote service
const users = peer.consumes(Users);
const user = await users.getUser({ id: 1 });
```

Rules:

- `provides()` registers services. Multiple calls accumulate. Duplicate routes are a hard error.
- `consumes()` returns a cached typed proxy. Lazily created, reused on subsequent calls.
- A pure server only calls `provides()`. A pure client only calls `consumes()`. Bidirectional does both.

### Controlled feeds

Feeds can expose a typed controller for client-to-server messages scoped to an active subscription:

```ts
import type { ControlledAsyncIterable } from "@scomp/core";

type PricingContract = {
  prices(input: { symbols: string[] }): ControlledAsyncIterable<
    { symbol: string; price: number },
    {
      addSymbol(input: { symbol: string }): Promise<void>;
      getInterval(input: {}): Promise<{ intervalMs: number }>;
    }
  >;
};

const Pricing = createContractToken<PricingContract>("pricing");

// Client usage
const pricing = peer.consumes(Pricing);
const feed = pricing.prices({ symbols: ["AAPL"] });

for await (const tick of feed) {
  console.log(tick);
}

await feed.controller.addSymbol({ symbol: "GOOG" });
```

### Fragment composition

Split service implementations across modules, then compose:

```ts
import { createScompFragment, composeScompFragments } from "@scomp/core";

const usersRequests = createScompFragment(Users).implement({
  requests: { getUser: async ({ id }) => ({ id, name: `user-${id}` }) },
});

const usersSignals = createScompFragment(Users).implement({
  signals: { notifyLogin: async () => {} },
});

const usersFeeds = createScompFragment(Users).implement({
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});

const usersService = composeScompFragments(
  usersRequests,
  usersSignals,
  usersFeeds,
);
```

Fragment composition rejects duplicate methods across fragments.

## Packages

- `@scomp/core` — contract tokens, peer, service builder, feed primitives, control plane, priority model
- `@scomp/types` — wire protocol types, contract type utilities, security types
- `@scomp/client` — typed client proxy (used internally by peer; direct use is legacy)
- `@scomp/transport-rabbitmq` — RabbitMQ transport
- `@scomp/transport-websocket-server` — Bun WebSocket server transport
- `@scomp/transport-websocket-server-node` — Node WebSocket server transport
- `@scomp/transport-websocket-browser` — browser WebSocket client transport
- `@scomp/transport-websocket-client` — Node WebSocket client transport
- `@scomp/transport-browser-windows` — same-origin browser tab/window transport (SharedWorker primary, BroadcastChannel fallback)
- `@scomp/transport-inprocess` — in-process transport (legacy compatibility only)
- `@scomp/transport-websocket-server-runtime` — internal shared runtime (do not import directly)

## WebSocket server package split (Bun vs Node)

The websocket server transport is split by runtime:

- **Bun runtime (`Bun.serve`)**: `@scomp/transport-websocket-server`
- **Node runtime (`ws` + `http`)**: `@scomp/transport-websocket-server-node`

See migration notes: [docs/migration-websocket-server-split.md](docs/migration-websocket-server-split.md)

## Security

- `meta.auth` is opaque and transport-agnostic; validate identity on the server.
- Browser-side security hooks are client policy, not a trust boundary.
- Control plane routes (`__scomp.*`) should be internal-only by default.
- Priority hints are advisory metadata unless enforced by transport/policy.

## Protocol reference

- [docs/transport-json-protocol.md](docs/transport-json-protocol.md)
- [docs/adr-peer-model-v2.md](docs/adr-peer-model-v2.md) — v2 architecture decisions
- [docs/adr-control-plane-v1.md](docs/adr-control-plane-v1.md) — control plane namespace and routes
- [docs/adr-priority-model-v1.md](docs/adr-priority-model-v1.md) — priority classes and defaults
