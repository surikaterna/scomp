# LLM Transport Patterns (Runnable Snippets)

Companion to root `llms.txt`. This page focuses on concise setup patterns by runtime.

## Validation gates for transport readiness

- Run repository gates: `npm run lint` and `npm test`.
- Validate browser-windows resilience suite directly: `bun run --filter='@scomp/transport-browser-windows' test`.
- Validate package-level lint gates directly: `bun run --filter='@scomp/transport-browser-windows' lint` plus websocket-adjacent package lint scripts.

## 1) Bun websocket server + browser client

```ts
import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createWebSocketBrowserTransport } from "@scomp/transport-websocket-browser";
import { createWebSocketServerTransport } from "@scomp/transport-websocket-server";

type Contract = {
  users: {
    get(input: { id: number }): Promise<{ id: number }>;
    ping(input: { id: number }): Promise<void>;
  };
};

const users = createScompService<Contract["users"]>("users").implement({
  requests: { get: async ({ id }) => ({ id }) },
  signals: { ping: async () => undefined },
});

const server = createWebSocketServerTransport({ port: 3399, path: "/" });
await server.listen(users.router);

const routeHints: ClientRouteHints = {
  "users.get": "request",
  "users.ping": "signal",
};

const browserTransport = createWebSocketBrowserTransport({ url: "ws://127.0.0.1:3399" });
const client = createScompClient<Contract>({ transport: browserTransport, routeHints });

await client.users.get({ id: 1 });
await client.users.ping({ id: 1 });
```

## 2) Node websocket server + Node websocket client

```ts
import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createWebSocketClientTransport } from "@scomp/transport-websocket-client";
import { createWebSocketServerTransport } from "@scomp/transport-websocket-server-node";

type Contract = {
  math: {
    add(input: { a: number; b: number }): Promise<{ sum: number }>;
  };
};

const math = createScompService<Contract["math"]>("math").implement({
  requests: { add: async ({ a, b }) => ({ sum: a + b }) },
});

const server = createWebSocketServerTransport({ port: 3399, path: "/" });
await server.listen(math.router);

const routeHints: ClientRouteHints = { "math.add": "request" };
const transport = createWebSocketClientTransport({ url: "ws://127.0.0.1:3399" });
const client = createScompClient<Contract>({ transport, routeHints });

await client.math.add({ a: 1, b: 2 });
```

## 3) RabbitMQ transport (single process pattern)

```ts
import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createRabbitMqTransport } from "@scomp/transport-rabbitmq";

type Contract = {
  jobs: {
    run(input: { id: string }): Promise<{ ok: true }>;
  };
};

const jobs = createScompService<Contract["jobs"]>("jobs").implement({
  requests: { run: async () => ({ ok: true }) },
});

const transport = createRabbitMqTransport({ url: "amqp://guest:guest@localhost:5672" });
await transport.listen(jobs.router);

const routeHints: ClientRouteHints = { "jobs.run": "request" };
const client = createScompClient<Contract>({ transport, routeHints });

await client.jobs.run({ id: "job-1" });
```

## 4) Browser windows transport (same-origin)

```ts
import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createBrowserWindowsTransport } from "@scomp/transport-browser-windows";

type Contract = {
  counter: {
    get(input: { id: string }): Promise<{ value: number }>;
  };
};

const transport = createBrowserWindowsTransport({ channelName: "scomp-app", mode: "auto" });

// In hosting window(s)
const counter = createScompService<Contract["counter"]>("counter").implement({
  requests: { get: async () => ({ value: 1 }) },
});
await transport.listen(counter.router);

// In invoking window(s)
const routeHints: ClientRouteHints = { "counter.get": "request" };
const client = createScompClient<Contract>({ transport, routeHints });
await client.counter.get({ id: "a" });
```

## 5) Inprocess compatibility pattern

`@scomp/transport-inprocess` is for legacy/core-compatible `ScompServiceDefinition` + `ScompTransport` flow.

```ts
import { createLegacyScompService, createScompClient as createLegacyClient } from "@scomp/core";
import { createInprocessTransport } from "@scomp/transport-inprocess";

const service = createLegacyScompService()
  .request("sum", async (a: number, b: number) => a + b)
  .build();

const transport = createInprocessTransport(service);
const client = createLegacyClient(service, transport);
await client.sum(1, 2);
```
