# ADR: SCOMP Peer Model and Controlled Feeds (v2)

- Status: Proposed
- Date: 2026-04-13

## Context

SCOMP v1 evolved organically through transport implementations (RabbitMQ, WebSocket, browser-windows) and a contract-driven service builder. The result is a working system with several architectural friction points:

1. **Client/server asymmetry**: `ITransport.listen()` throws on client transports instead of being a no-op, forcing callers to know transport directionality at the call site.
2. **No runtime contract binding**: the TypeScript contract type and the service name string are connected only by convention. Refactoring either breaks the other silently.
3. **Feed lifecycle gaps**: feeds are server-push only. Clients cannot send structured messages back to an active feed (e.g., change parameters, pause, request snapshots) without establishing a separate RPC side-channel.
4. **Wire protocol cruft**: four operations (`request`, `signal`, `feed_start`, `feed_stop`) when three suffice. `feed_stop` is a signal with extra context, not a distinct operation.
5. **Error semantics**: error responses carry a freeform string. Programmatic error handling requires parsing human-readable messages.

These problems compound: the asymmetric transport forces different code paths for the same logical peer, the missing contract token makes multi-version services error-prone, and the lack of feed controllers forces ad-hoc workarounds that differ per transport.

This ADR proposes a coordinated set of changes to address all five problems as a single coherent design.

## Decision

### 1. Contract Tokens

A `ContractToken<C>` binds a TypeScript contract type to a service name at runtime. It is the single source of truth for both sides of a service boundary.

```typescript
interface ContractToken<C extends object> {
  readonly name: string;
  readonly __contract: C; // phantom type, never read at runtime
}

function createContractToken<C extends object>(name: string): ContractToken<C>;
```

Usage:

```typescript
const TradingV1 = createContractToken<TradingContract>('trading');
const TradingV2 = createContractToken<TradingContractV2>('trading.v2');

// Server side
peer.provides(
  createScompService(TradingV1).implement({ ... })
);

// Client side
const trading = peer.consumes(TradingV1);
await trading.getPrice({ symbol: 'AAPL' });
```

Contract tokens replace the current pattern where `createScompService<Contract>('name')` takes a separate generic parameter and string argument. The token unifies both into one object.

### 2. Peer Model

Replace the client/server split with a symmetric `IScompPeer`. A peer is a node that can provide services (handle incoming calls) and/or consume services (make outgoing calls) over one or more transports.

```typescript
interface IScompPeer {
  provides(...services: ServiceDefinition<object>[]): void;
  consumes<C extends object>(token: ContractToken<C>): ScompClientProxy<C>;
  close(): Promise<void>;
}
```

Semantics:

- `provides()` registers services this peer hosts. Multiple calls accumulate. Duplicate routes are a hard error.
- `consumes()` returns a cached `ScompClientProxy<C>` for the given token. The proxy is lazily created on first access and reused thereafter.
- Both are optional. A pure server only calls `provides()`. A pure client only calls `consumes()`. A bidirectional node calls both.
- `close()` tears down all transports and feed subscriptions.

```typescript
function createScompPeer(config: { transports: IScompTransport[] }): IScompPeer;
```

### 3. Transport Interface

`IScompTransport` is wire-level only. It moves bytes (or structured messages) between peers and nothing else.

```typescript
interface IScompTransport {
  request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown>;
  signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void>;
  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown>;
  registerRoutes(router: CompiledRouter): Promise<void> | void;
  close(): Promise<void> | void;
}
```

Changes from v1 `ITransport`:

- `listen(router)` becomes `registerRoutes(router)`. Client-only transports implement this as a no-op instead of throwing. The name clarifies intent: you are registering route handlers, not "listening" on a port.
- No other method changes. `request`, `signal`, `feed`, `close` remain identical.

### 4. Controlled Feeds

A controlled feed is a server-sent async iterable that also exposes a typed controller for client-to-server messages scoped to the active subscription.

```typescript
interface ControlledAsyncIterable<T, C> extends AsyncIterable<T> {
  readonly controller: C;
}
```

Controller method conventions follow the same return-type inference as contract methods:

- `(input) => Promise<T>` — request (returns a value)
- `(input) => Promise<void>` — signal (fire-and-forget)
- Nested feeds on controllers are not supported (no `AsyncIterable` return types).

Server-side creation:

```typescript
function createControlledFeed<T, C>(
  iterable: AsyncIterable<T>,
  controllerMethods: C,
): ControlledAsyncIterable<T, C>;
```

Example:

```typescript
type PriceContract = {
  prices: (input: { symbols: string[] }) => ControlledAsyncIterable<
    PriceTick,
    {
      addSymbol: (input: { symbol: string }) => Promise<void>;
      removeSymbol: (input: { symbol: string }) => Promise<void>;
      getInterval: (input: {}) => Promise<{ intervalMs: number }>;
    }
  >;
};

// Client usage
const feed = trading.prices({ symbols: ["AAPL"] });
for await (const tick of feed) {
  console.log(tick);
}

// Controller calls on the active feed
await feed.controller.addSymbol({ symbol: "GOOG" });
const { intervalMs } = await feed.controller.getInterval({});
```

#### Feed controller scoping

- **Exclusive feeds** (per-subscription): each subscriber gets their own feed instance and controller. Controller state is isolated.
- **Fanout feeds** (shared): subscribers share a feed instance. Controller calls go to the shared instance. The service author is responsible for safe concurrent access to shared controller state. Framework controller methods (`__scomp.*`) remain per-subscription even on fanout feeds.

### 5. Unified Wire Protocol

Reduce to three operations: `request`, `signal`, `feed`. Remove `feed_stop`.

#### Envelope changes

Request envelope gains optional `feed` and `method` fields:

```typescript
interface RequestEnvelope {
  route: string; // e.g. "trading.prices"
  op: "request" | "signal" | "feed"; // was: 'request' | 'signal' | 'feed_start' | 'feed_stop'
  payload: unknown;
  meta?: TransportMessageMeta;
  feed?: string; // new: feed subscription ID (for controller calls)
  method?: string; // new: controller method name (for controller calls)
}
```

Response envelope gains a `code` field:

```typescript
interface ResponseEnvelope {
  payload?: unknown;
  error?: string;
  code?: string; // new: structured error code
}
```

Feed chunk envelope renames `hash` to `feed`:

```typescript
interface FeedChunkEnvelope {
  id: string;
  type: "next" | "done" | "error";
  channel: "feed";
  feed: string; // was: hash
  payload?: unknown;
  message?: string;
}
```

#### Operation mapping

| v1 Operation | v2 Operation                                           | Notes                   |
| ------------ | ------------------------------------------------------ | ----------------------- |
| `request`    | `request`                                              | Unchanged               |
| `signal`     | `signal`                                               | Unchanged               |
| `feed_start` | `feed`                                                 | Renamed for consistency |
| `feed_stop`  | `signal` with `feed` + `method: '__scomp.unsubscribe'` | Collapsed into signal   |

#### Controller calls on the wire

Controller method calls on active feeds reuse `request` and `signal` operations with `feed` and `method` fields:

```json
{
  "route": "trading.prices",
  "op": "request",
  "feed": "7d8f67a9-d3a4-e9f0-c1b2-d3e4f5a6b7c8",
  "method": "getInterval",
  "payload": {}
}
```

The `feed` field identifies the subscription. The `method` field identifies the controller method. The `op` field follows the same return-type inference: `request` for methods returning a value, `signal` for void methods.

Unsubscribe is a signal with a framework-reserved method:

```json
{
  "route": "trading.prices",
  "op": "signal",
  "feed": "7d8f67a9-d3a4-e9f0-c1b2-d3e4f5a6b7c8",
  "method": "__scomp.unsubscribe",
  "payload": {}
}
```

#### Framework-reserved controller methods

All framework controller methods use the `__scomp.` prefix. This avoids collision with user-defined controller methods and is consistent with the `__scomp.*` route namespace reservation.

| Method                | Op        | Purpose                                              |
| --------------------- | --------- | ---------------------------------------------------- |
| `__scomp.unsubscribe` | `signal`  | Tear down a feed subscription (replaces `feed_stop`) |
| `__scomp.pause`       | `signal`  | Pause feed emission (future)                         |
| `__scomp.resume`      | `signal`  | Resume feed emission (future)                        |
| `__scomp.stats`       | `request` | Query feed subscription stats (future)               |

Rules:

- User-defined controller method names MUST NOT start with `__scomp.`.
- Registration of a controller method starting with `__scomp.` MUST fail with a clear error.
- Framework methods are available on all feed subscriptions regardless of the controller type declared by the service.

### 6. Control Plane as Contract

The existing `__scomp.*` control-plane routes (`discover`, `resolve`, `health`) become a first-class contract with a token:

```typescript
type ScompControlPlaneContract = {
  discover: (input: {
    servicePrefix?: string;
    includeRoutes?: boolean;
  }) => Promise<{
    services: Array<{ name: string; routes?: string[] }>;
    node: { id: string };
  }>;

  resolve: (input: {
    route: string;
    channel?: string;
  }) => Promise<{
    resolved: boolean;
    endpoint?: { route: string; channel: string; transport?: string };
    fallbackUsed: boolean;
  }>;

  health: (input: {
    verbose?: boolean;
  }) => Promise<{
    status: "ok" | "degraded" | "down";
    checks?: Array<{ name: string; status: string; message?: string }>;
    node: { id: string };
  }>;
};

const ScompControlPlane =
  createContractToken<ScompControlPlaneContract>("__scomp");
```

The control plane is implemented and consumed like any other service:

```typescript
// Peer automatically provides the control plane
const peer = createScompPeer({ transports: [transport] });

// Any peer can consume another peer's control plane
const cp = peer.consumes(ScompControlPlane);
const services = await cp.discover({ includeRoutes: true });
```

### 7. Error Handling

Structured error codes replace freeform error strings for programmatic handling. The `code` field is added to response envelopes.

| Code                   | Meaning                                                   |
| ---------------------- | --------------------------------------------------------- |
| `ROUTE_NOT_FOUND`      | No handler registered for the route                       |
| `SERVICE_NOT_FOUND`    | Service name prefix does not match any registered service |
| `CONTROLLER_NOT_FOUND` | Controller method not found on the feed                   |
| `FEED_NOT_FOUND`       | Feed subscription ID does not exist or has expired        |
| `TIMEOUT`              | Operation exceeded deadline                               |
| `UNAUTHORIZED`         | Authentication or authorization failed                    |

Rules:

- `code` is present on error responses, absent on success responses.
- `error` remains as a human-readable message for logging and diagnostics.
- Unknown codes MUST be treated as unrecoverable errors by clients.
- Transports MUST NOT invent codes outside this set without a protocol version bump.

### 8. Naming Conventions

- `command` is renamed to `signal` throughout (already done on `develop`).
- `hash` is renamed to `feed` in all envelope fields for consistency.
- `listen()` is renamed to `registerRoutes()` on the transport interface.
- Client-side: `consumes(token)` / Server-side: `provides(...services)`.

## Migration Path

### Wire protocol

The `feed` operation replaces `feed_start`. Transports SHOULD accept both `feed_start` and `feed` during a transition period and emit only `feed`. `feed_stop` is replaced by `__scomp.unsubscribe` signals immediately; no dual-support period.

### Transport interface

`listen()` is renamed to `registerRoutes()`. The old method name can be supported as a deprecated alias during transition.

### Client/server code

Existing `createScompService` and `createScompClient` continue to work. `ContractToken` is additive — the builder accepts either a token or a name+generic. Migration is opt-in per service.

## Compatibility Guarantees

- Existing request/signal envelope shapes are unchanged.
- Feed chunk envelopes change only the field name `hash` -> `feed`.
- `meta` field semantics are unchanged.
- Priority model (ADR v1) is unaffected.
- Control-plane route names are unchanged; they gain a typed contract but the wire representation is identical.

## Explicit Non-Goals (v2)

- No service mesh or cross-node peer discovery (peers are connected via explicit transports).
- No automatic contract versioning negotiation (version is encoded in the token name by convention).
- No feed backpressure protocol changes (backpressure remains transport-level).
- No nested feeds on controllers.
- No transport-level multiplexing changes.

## Consequences

- Contract tokens eliminate the class of bugs where a service name string and generic type parameter drift apart.
- The peer model removes the client/server transport asymmetry, making bidirectional communication a natural pattern instead of a special case.
- Controlled feeds enable rich feed interactions without ad-hoc side channels, making patterns like parameterized subscriptions, pause/resume, and subscription stats first-class.
- The unified wire protocol is simpler (3 ops vs 4) and extensible (controller calls reuse existing ops with scoping fields rather than introducing new operations).
- The `__scomp.` prefix for framework controller methods is consistent with the existing route namespace reservation and provides clear collision avoidance.
- Structured error codes enable programmatic error handling without string parsing.
