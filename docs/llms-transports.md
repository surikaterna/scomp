# LLM Transport Patterns (Runnable Snippets)

Companion to root `llms.txt`. This page focuses on concise setup patterns by runtime.

## Validation gates for transport readiness

- Run repository gates: `bunx turbo run lint` and `bunx turbo run test`.
- Validate browser-windows resilience suite directly: `bun run --filter='@scomp/transport-browser-windows' test`.
- Validate package-level lint gates directly: `bun run --filter='@scomp/transport-browser-windows' lint`.

## 1) Bun websocket server + browser client

```ts
import {
  createContractToken,
  createScompPeer,
  createScompService,
  createAuthMiddleware,
} from "@scomp/core";
import { createScompClient } from "@scomp/client";
import { createBunWebSocketServerTransport } from "@scomp/transport-websocket-server";
import {
  createWebSocketClientTransport,
  createBrowserSocketAdapterFactory,
} from "@scomp/transport-websocket-client";

type Contract = {
  users: {
    get(input: { id: number }): Promise<{ id: number }>;
    ping(input: { id: number }): Promise<void>;
  };
};

const Users = createContractToken<Contract["users"]>("users");

// Optional auth middleware
const authMw = createAuthMiddleware({
  authenticate: (ctx) => ({ subject: "user-1" }),
  authorize: (ctx) => true,
});

// Server peer (Bun runtime)
const serverTransport = createBunWebSocketServerTransport({
  port: 3399,
  path: "/",
});
const server = createScompPeer({
  transports: [serverTransport],
  clientFactory: createScompClient,
  middleware: [authMw],
});

server.provides(
  createScompService(Users).implement({
    requests: { get: async ({ id }) => ({ id }) },
    signals: { ping: async () => undefined },
  }),
);

// Client peer (browser runtime)
const clientTransport = createWebSocketClientTransport({
  url: "ws://127.0.0.1:3399",
  socketAdapter: createBrowserSocketAdapterFactory(),
});
const client = createScompPeer({
  transports: [clientTransport],
  clientFactory: createScompClient,
});

const users = client.consumes(Users);
await users.get({ id: 1 });
await users.ping({ id: 1 });
```

## 2) Node websocket server + Node websocket client

```ts
import {
  createContractToken,
  createScompPeer,
  createScompService,
} from "@scomp/core";
import { createScompClient } from "@scomp/client";
import { createNodeWebSocketServerTransport } from "@scomp/transport-websocket-server";
import {
  createWebSocketClientTransport,
  createNodeSocketAdapterFactory,
} from "@scomp/transport-websocket-client";

type Contract = {
  math: {
    add(input: { a: number; b: number }): Promise<{ sum: number }>;
  };
};

const Math = createContractToken<Contract["math"]>("math");

// Server peer (Node runtime)
const serverTransport = createNodeWebSocketServerTransport({
  port: 3399,
  path: "/",
});
const server = createScompPeer({
  transports: [serverTransport],
  clientFactory: createScompClient,
});

server.provides(
  createScompService(Math).implement({
    requests: { add: async ({ a, b }) => ({ sum: a + b }) },
  }),
);

// Client peer (Node runtime)
const clientTransport = createWebSocketClientTransport({
  url: "ws://127.0.0.1:3399",
  socketAdapter: createNodeSocketAdapterFactory(),
});
const client = createScompPeer({
  transports: [clientTransport],
  clientFactory: createScompClient,
});

const math = client.consumes(Math);
await math.add({ a: 1, b: 2 });
```

## 3) RabbitMQ transport (single process pattern)

```ts
import {
  createContractToken,
  createScompPeer,
  createScompService,
} from "@scomp/core";
import { createScompClient } from "@scomp/client";
import { createRabbitMqTransport } from "@scomp/transport-rabbitmq";

type Contract = {
  jobs: {
    run(input: { id: string }): Promise<{ ok: true }>;
  };
};

const Jobs = createContractToken<Contract["jobs"]>("jobs");

// Single peer that both provides and consumes (bidirectional)
const transport = createRabbitMqTransport({
  url: "amqp://guest:guest@localhost:5672",
});
const peer = createScompPeer({
  transports: [transport],
  clientFactory: createScompClient,
});

peer.provides(
  createScompService(Jobs).implement({
    requests: { run: async () => ({ ok: true as const }) },
  }),
);

const jobs = peer.consumes(Jobs);
await jobs.run({ id: "job-1" });
```

## 4) Browser windows transport (same-origin)

```ts
import {
  createContractToken,
  createScompPeer,
  createScompService,
} from "@scomp/core";
import { createScompClient } from "@scomp/client";
import { createBrowserWindowsTransport } from "@scomp/transport-browser-windows";

type Contract = {
  counter: {
    get(input: { id: string }): Promise<{ value: number }>;
  };
};

const Counter = createContractToken<Contract["counter"]>("counter");

const transport = createBrowserWindowsTransport({
  channelName: "scomp-app",
  mode: "auto",
});

// In hosting window(s)
const server = createScompPeer({
  transports: [transport],
  clientFactory: createScompClient,
});
server.provides(
  createScompService(Counter).implement({
    requests: { get: async () => ({ value: 1 }) },
  }),
);

// In invoking window(s)
const client = createScompPeer({
  transports: [transport],
  clientFactory: createScompClient,
});
const counter = client.consumes(Counter);
await counter.get({ id: "a" });
```

## 5) Controlled feed over websocket

```ts
import {
  createContractToken,
  createControlledFeed,
  createScompPeer,
  createScompService,
} from "@scomp/core";
import type { ControlledAsyncIterable } from "@scomp/core";
import { createScompClient } from "@scomp/client";
import { createBunWebSocketServerTransport } from "@scomp/transport-websocket-server";
import {
  createWebSocketClientTransport,
  createBrowserSocketAdapterFactory,
} from "@scomp/transport-websocket-client";

type PriceTick = { symbol: string; price: number };

type PricingContract = {
  prices(input: { symbols: string[] }): ControlledAsyncIterable<
    PriceTick,
    {
      addSymbol(input: { symbol: string }): Promise<void>;
      getInterval(input: {}): Promise<{ intervalMs: number }>;
    }
  >;
};

const Pricing = createContractToken<PricingContract>("pricing");

// Server (Bun runtime)
const serverTransport = createBunWebSocketServerTransport({
  port: 3399,
  path: "/",
});
const server = createScompPeer({
  transports: [serverTransport],
  clientFactory: createScompClient,
});

server.provides(
  createScompService(Pricing).implement({
    feeds: {
      prices: {
        strategy: "exclusive",
        handler: async function* ({ symbols }) {
          const state = { symbols: [...symbols], intervalMs: 1000 };

          return createControlledFeed(
            (async function* () {
              while (true) {
                for (const symbol of state.symbols) {
                  yield { symbol, price: Math.random() * 100 };
                }
                await new Promise((r) => setTimeout(r, state.intervalMs));
              }
            })(),
            {
              addSymbol: async ({ symbol }) => {
                state.symbols.push(symbol);
              },
              getInterval: async () => ({ intervalMs: state.intervalMs }),
            },
          );
        },
      },
    },
  }),
);

// Client (browser runtime)
const clientTransport = createWebSocketClientTransport({
  url: "ws://127.0.0.1:3399",
  socketAdapter: createBrowserSocketAdapterFactory(),
});
const client = createScompPeer({
  transports: [clientTransport],
  clientFactory: createScompClient,
});

const pricing = client.consumes(Pricing);
const feed = pricing.prices({ symbols: ["AAPL"] });

await feed.controller.addSymbol({ symbol: "GOOG" });

for await (const tick of feed) {
  console.log(tick);
  break;
}
```
