# Migration: WebSocket Server Runtime-Specific Factories

The WebSocket server transport now provides explicit runtime-specific factory functions
instead of a single generic `createWebSocketServerTransport`.

## What changed

- Both Bun and Node server transports live in the **same package**: `@scompr/transport-websocket-server`.
- `createBunWebSocketServerTransport` — uses `Bun.serve`.
- `createNodeWebSocketServerTransport` — uses `ws` + `node:http`.
- The old `createWebSocketServerTransport` is a **deprecated alias** for the Bun factory.

There is NO separate `@scompr/transport-websocket-server-node` package.

## Migration

### Bun

```ts
// Before
import { createWebSocketServerTransport } from "@scompr/transport-websocket-server";

// After (explicit)
import { createBunWebSocketServerTransport } from "@scompr/transport-websocket-server";

const transport = createBunWebSocketServerTransport({
  port: 3000,
  host: "127.0.0.1", // optional
  path: "/ws",        // optional
});
```

### Node

```ts
// Before
import { createWebSocketServerTransport } from "@scompr/transport-websocket-server";

// After (explicit)
import { createNodeWebSocketServerTransport } from "@scompr/transport-websocket-server";

const transport = createNodeWebSocketServerTransport({
  port: 3000,
  // or provide your own server:
  // server: httpServer,
});
```

## Config reference

| Field      | Bun                | Node                          |
|------------|--------------------|-------------------------------|
| `port`     | **required**       | optional (if `server` given)  |
| `host`     | optional           | optional                      |
| `path`     | optional           | optional                      |
| `server`   | —                  | optional `http`/`https` server|
| `outbound` | optional client    | optional client               |

## Deprecated aliases

The following are re-exported for backward compatibility but will be removed in a future release:

- `createWebSocketServerTransport` → `createBunWebSocketServerTransport`
- `WebSocketServerTransport` → `BunWebSocketServerTransport`

## Protocol semantics

No wire-protocol semantics changed. Request/signal/feed behavior and the transport JSON
protocol remain as documented in `docs/transport-json-protocol.md`.
