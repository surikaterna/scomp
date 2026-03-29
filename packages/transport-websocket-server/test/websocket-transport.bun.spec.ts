// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { WebSocketClientTransport } from "../../transport-websocket-client/src";
import { WebSocketServerTransport } from "../src";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<Array<T>> {
  const values: Array<T> = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

async function reservePort(): Promise<number> {
  const server = createServer();

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to reserve an ephemeral port."));
        return;
      }

      resolve(address.port);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return port;
}

const transports: Array<WebSocketServerTransport | WebSocketClientTransport> = [];

afterEach(async () => {
  while (transports.length > 0) {
    const transport = transports.pop();
    await transport?.close();
  }
});

describe("WebSocketServerTransport Bun integration", () => {
  test("starts server and upgrades only configured path", async () => {
    const port = await reservePort();

    const serverTransport = new WebSocketServerTransport({
      port,
      path: "/ws",
    });
    transports.push(serverTransport);

    await serverTransport.listen({
      "health.ping": {
        route: "health.ping",
        kind: "request",
        handler: async () => "pong",
      },
    });

    const wrongPathResponse = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(wrongPathResponse.status).toBe(404);

    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/ws`,
    });
    transports.push(client);

    const value = await client.request("health.ping", null);
    expect(value).toBe("pong");
  });

  test("handles request, signal, and feed envelopes end-to-end", async () => {
    const port = await reservePort();
    const seenSignals: Array<unknown> = [];

    const serverTransport = new WebSocketServerTransport({ port, path: "/ws" });
    transports.push(serverTransport);

    await serverTransport.listen({
      "math.double": {
        route: "math.double",
        kind: "request",
        handler: async (value: number) => value * 2,
      },
      "math.notify": {
        route: "math.notify",
        kind: "signal",
        handler: async (payload: unknown) => {
          seenSignals.push(payload);
        },
      },
      "math.count": {
        route: "math.count",
        kind: "feed",
        strategy: "fanout",
        hashKey: (payload: unknown) => String((payload as { room: string }).room),
        handler: async function* () {
          yield 1;
          yield 2;
          yield 3;
        },
      },
    });

    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/ws`,
    });
    transports.push(client);

    await expect(client.request("math.double", 21)).resolves.toBe(42);

    await client.signal("math.notify", { id: 7 });
    await wait(20);
    expect(seenSignals).toEqual([{ id: 7 }]);

    await expect(collect(client.feed("math.count", { room: "main" }))).resolves.toEqual(
      [1, 2, 3],
    );
  });

  test("denies unauthorized inbound request/signal/feed operations", async () => {
    const port = await reservePort();
    const deniedSignals: Array<unknown> = [];

    const serverTransport = new WebSocketServerTransport({
      port,
      path: "/ws",
      security: {
        authenticate: ({ meta }) => {
          const token = (meta as { auth?: { token?: string } } | undefined)?.auth
            ?.token;
          if (token === "allow") {
            return { subject: "user:allow" };
          }

          return null;
        },
        authorize: ({ principal }) => principal?.subject === "user:allow",
      },
    });
    transports.push(serverTransport);

    await serverTransport.listen({
      "secure.request": {
        route: "secure.request",
        kind: "request",
        handler: async (payload: unknown) => payload,
      },
      "secure.signal": {
        route: "secure.signal",
        kind: "signal",
        handler: async (payload: unknown) => {
          deniedSignals.push(payload);
        },
      },
      "secure.feed": {
        route: "secure.feed",
        kind: "feed",
        strategy: "fanout",
        handler: async function* () {
          yield "never";
        },
      },
    });

    const deniedClient = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/ws`,
      meta: { auth: { token: "deny" } },
    });
    transports.push(deniedClient);

    const allowedClient = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}/ws`,
      meta: { auth: { token: "allow" } },
    });
    transports.push(allowedClient);

    await expect(deniedClient.request("secure.request", { id: 1 })).rejects.toThrow(
      /not authorized/i,
    );
    await expect(allowedClient.request("secure.request", { id: 2 })).resolves.toEqual(
      { id: 2 },
    );

    await deniedClient.signal("secure.signal", { denied: true });
    await wait(20);
    expect(deniedSignals).toEqual([]);

    await expect(
      collect(deniedClient.feed("secure.feed", { stream: "all" })),
    ).rejects.toThrow(/not authorized/i);
  });
});
