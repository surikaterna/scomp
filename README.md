# sComPR

> Formerly known as "scomp"

sComPR is a transport-agnostic RPC toolkit with first-class `request`, `signal`, and `feed` semantics.

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
import { createContractToken } from "@scompr/core";

type UsersContract = {
  getUser(input: { id: number }): Promise<{ id: number; name: string }>;
  notifyLogin(input: { id: number; at: string }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
};

const Users = createContractToken<UsersContract>("users");
```

Contract methods must return `Promise<T>` (request), `AsyncIterable<T>` (feed), or `void`/`Promise<void>` (signal).
Invalid return types produce compile-time errors at the `createScompService` call site.

### Peer model

A peer is a symmetric node that can host services and/or call remote services:

```ts
import { createScompPeer, createScompService } from "@scompr/core";
import { createScompClient } from "@scompr/client";

const peer = createScompPeer({
  transports: [transport],
  clientFactory: createScompClient,
});

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
import type { ControlledAsyncIterable } from "@scompr/core";

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

### Middleware

Auth and cross-cutting concerns are handled by transport-agnostic middleware at the peer level:

```ts
import { createAuthMiddleware, createScompPeer } from "@scompr/core";
import { createScompClient } from "@scompr/client";

const authMw = createAuthMiddleware({
  authenticate: (ctx) => ({ subject: "user-1", tenantId: "tenant-a" }),
  authorize: ({ principal, route, operation }) => true,
});

const peer = createScompPeer({
  transports: [transport],
  clientFactory: createScompClient,
  middleware: [authMw],
});
```

Middleware intercepts both inbound (server-side) and outbound (client-side) operations:

- **Inbound**: authenticate caller identity, authorize access, transform payloads
- **Outbound**: inject auth metadata into `meta.auth`, block unauthorized calls before transport

If no middleware is configured, peers allow all operations (backward compatible).

### Fragment composition

Split service implementations across modules, then compose:

```ts
import { createScompFragment, composeScompFragments } from "@scompr/core";

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

- `@scompr/core` — contract tokens, peer, service builder, feed primitives, control plane, priority model, contract validation, middleware
- `@scompr/types` — wire protocol types, contract type utilities, security types
- `@scompr/client` — typed client proxy (provides `clientFactory` for peer model)
- `@scompr/transport-shared` — cross-transport utilities (meta composition, parsing, feed detection)
- `@scompr/transport-websocket-shared` — WebSocket adapter abstraction (`ISocketAdapter`, `NodeSocketAdapter`, `BrowserSocketAdapter`)
- `@scompr/transport-websocket-client` — unified WebSocket client (Node + Browser via socket adapters)
- `@scompr/transport-websocket-server` — unified WebSocket server (Bun + Node entry points)
- `@scompr/transport-websocket-server-runtime` — internal shared server runtime (do not import directly)
- `@scompr/transport-rabbitmq` — RabbitMQ transport
- `@scompr/transport-browser-windows` — same-origin browser tab/window transport (SharedWorker primary, BroadcastChannel fallback)
- `@scompr/transport-inprocess` — in-process transport

## WebSocket server runtimes

The websocket server package supports both runtimes from a single package:

- **Bun**: `import { createBunWebSocketServerTransport } from "@scompr/transport-websocket-server"`
- **Node**: `import { createNodeWebSocketServerTransport } from "@scompr/transport-websocket-server"`

## Security

Security is enforced via middleware at the peer level (see Middleware section above).

- `meta.auth` is opaque and transport-agnostic; validate identity on the server peer.
- Browser-side middleware is client policy, not a trust boundary.
- Control plane routes (`__scomp.*`) should be internal-only by default.
- Priority hints are advisory metadata unless enforced by transport/policy.

## Protocol reference

- [docs/transport-json-protocol.md](docs/transport-json-protocol.md)
- [docs/adr-peer-model-v2.md](docs/adr-peer-model-v2.md) — v2 architecture decisions
- [docs/adr-control-plane-v1.md](docs/adr-control-plane-v1.md) — control plane namespace and routes
- [docs/adr-priority-model-v1.md](docs/adr-priority-model-v1.md) — priority classes and defaults
