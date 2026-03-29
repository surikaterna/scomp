# Migration: websocket server package split

SCOMP websocket server transport has been split by runtime target.

## What changed

- `@scomp/transport-websocket-server` is now **Bun-first** (`Bun.serve`).
- Node (`ws` + `http`) server transport now lives in `@scomp/transport-websocket-server-node`.

## Breaking change (Node imports)

If you run websocket server transport on Node, update imports:

```ts
// Before
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server';

// After
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server-node';
```

The same rename applies to `WebSocketServerTransport` and related server-side types.

## Bun usage

Bun usage remains on `@scomp/transport-websocket-server`:

```ts
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server';

const transport = createWebSocketServerTransport({
  port: 3000,
  outbound: { url: 'ws://127.0.0.1:3000' }
});
```

## Node usage

Node usage must import from `@scomp/transport-websocket-server-node`:

```ts
import { createServer } from 'node:http';
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server-node';

const httpServer = createServer();
const transport = createWebSocketServerTransport({
  server: httpServer,
  outbound: { url: 'ws://127.0.0.1:3000' }
});
```

## Protocol semantics

No wire-protocol semantics changed as part of this split. Request/signal/feed behavior and
transport JSON protocol remain as documented in `docs/transport-json-protocol.md`.
