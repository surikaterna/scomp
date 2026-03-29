import {
  createScompClient,
  type ClientRouteHints,
} from "@scomp/client";
import { createScompService } from "@scomp/core";
import { createWebSocketBrowserTransport } from "@scomp/transport-websocket-browser";
import { createWebSocketServerTransport } from "@scomp/transport-websocket-server";
import type {
  ScompTransportSecurityContext,
  ScompTransportSecurityPolicy,
} from "@scomp/types";

const WsWebSocket = require("ws") as any;
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

class WsBrowserAdapter {
  private readonly socket: any;

  constructor(url: string, protocols?: string | Array<string>) {
    this.socket = new WsWebSocket(url, protocols as never);

  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(payload: string): void {
    this.socket.send(payload);
  }

  close(): void {
    this.socket.close();
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "message") {
      this.socket.on("message", (data: unknown) => listener({ data }));
      return;
    }

    this.socket.on(type as "open" | "close" | "error", listener as () => void);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "message") {
      this.socket.off("message", listener as (event: unknown) => void);
      return;
    }

    this.socket.off(type as "open" | "close" | "error", listener as () => void);
  }
}

const usersService = createScompService<DemoApiContract["users"]>("users").implement({
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
    handler: async function* (input: LiveTickerInput): AsyncIterable<LiveTickerTick> {
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

  const securityPolicy: ScompTransportSecurityPolicy = {
    authenticate: ({ operation }: Omit<ScompTransportSecurityContext, "principal">) => ({
      subject: `browser-demo:${operation}`,
      tenantId: "tenant-browser-demo",
      claims: { source: "run-browser" },
    }),
    authorize: ({ route }: ScompTransportSecurityContext) =>
      route.startsWith("users."),
  };

  const server = createWebSocketServerTransport({
    port,
    host: "127.0.0.1",
    security: securityPolicy,
  });
  await server.listen(usersService.router);

  const transport = createWebSocketBrowserTransport({
    url,
    webSocketCtor: WsBrowserAdapter as unknown as new (
      url: string,
      protocols?: string | Array<string>,
    ) => any,
    meta: {
      traceId: "demo-browser-trace",
      tags: { source: "demo-browser" },
    },
    security: {
      authenticate: ({ operation }: Omit<ScompTransportSecurityContext, "principal">) => ({
        subject: `client:${operation}`,
        tenantId: "tenant-client",
        claims: { source: "browser-client-hook" },
      }),
      authorize: ({ route }: ScompTransportSecurityContext) => route.startsWith("users."),
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
