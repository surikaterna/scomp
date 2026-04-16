import { createScompClient, type ClientRouteHints } from "@scomp/client";
import { createContractToken, createScompService } from "@scomp/core";
import {
  createWebSocketClientTransport,
  createNodeSocketAdapterFactory,
} from "@scomp/transport-websocket-client";
import { createNodeWebSocketServerTransport } from "@scomp/transport-websocket-server";
import type {
  DemoApiContract,
  LiveTickerInput,
  LiveTickerTick,
} from "./shared/api.contract";

const routeHints: ClientRouteHints = {
  "users.getUser": "request",
  "users.notifyLogin": "signal",
  "users.liveTicker": "feed",
};

const usersToken = createContractToken<DemoApiContract["users"]>("users");

const usersService = createScompService(usersToken).implement({
  getUser: {
    kind: "request",
    parser: (payload: unknown): { id: number } => {
      const input = payload as { id: number };
      return { id: Number(input.id) };
    },
    handler: async (input: { id: number }) => ({
      id: input.id,
      name: `user-${input.id}`,
    }),
  },
  notifyLogin: {
    kind: "signal",
    parser: (payload: unknown): { userId: number; at: string } => {
      const input = payload as { userId: number; at: string };
      return {
        userId: Number(input.userId),
        at: String(input.at),
      };
    },
    handler: async (input: { userId: number; at: string }) => {
      console.log("[browser-signal] user login notified", input);
    },
  },
  liveTicker: {
    kind: "feed",
    strategy: "fanout",
    hashKey: (input: LiveTickerInput) => input.channel,
    handler: async function* (
      input: LiveTickerInput,
    ): AsyncIterable<LiveTickerTick> {
      let sequence = 0;
      try {
        while (true) {
          sequence += 1;
          await new Promise((resolve) => setTimeout(resolve, 100));
          yield {
            channel: input.channel,
            sequence,
            at: new Date().toISOString(),
          };
        }
      } finally {
        console.log("[browser-feed] teardown for channel", input.channel);
      }
    },
  },
});

async function runBrowserDemo() {
  const port = Number(process.env.SCOMP_BROWSER_DEMO_PORT ?? 3399);
  const url = `ws://127.0.0.1:${port}`;

  const server = createNodeWebSocketServerTransport({
    port,
    host: "127.0.0.1",
  });
  await server.registerRoutes(usersService.router);

  const transport = createWebSocketClientTransport({
    url,
    socketAdapter: createNodeSocketAdapterFactory(),
    meta: {
      traceId: "demo-browser-trace",
      tags: { source: "demo-browser" },
    },
  });

  const client = createScompClient<DemoApiContract>({
    transport,
    routeHints,
  });

  const user = await client.users.getUser(
    { id: 7 },
    {
      meta: { tenantId: "tenant-invoke", tags: { feature: "parity" } },
      priority: "P0",
      priorityClass: "P1",
      deadlineAtMs: Date.now() + 1_000,
      targetLatencyMs: 25,
    },
  );
  console.log("browser request result:", user);

  await client.users.notifyLogin(
    { userId: user.id, at: new Date().toISOString() },
    {
      meta: { tenantId: "tenant-signal" },
      priority: "P2",
      targetLatencyMs: 60,
    },
  );
  console.log("browser signal sent: users.notifyLogin");

  let seen = 0;
  for await (const tick of client.users.liveTicker(
    { channel: "prices" },
    {
      meta: { tenantId: "tenant-feed" },
      priority: "P1",
      deadlineAtMs: Date.now() + 3_000,
    },
  )) {
    console.log("browser feed chunk:", tick);
    seen += 1;
    if (seen >= 3) {
      break;
    }
  }

  console.log("browser feed stopped after 3 chunks");
  process.exit(0);
}

void runBrowserDemo().catch((error) => {
  console.error("run-browser failed", error);
  process.exit(1);
});
