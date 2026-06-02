// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { WebSocketClientTransport, createBrowserSocketAdapterFactory } from "@scompr/transport-websocket-client";
import { BunWebSocketServerTransport } from "../src/bun";

const bunSocketAdapter = createBrowserSocketAdapterFactory();

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

const transports: Array<BunWebSocketServerTransport | WebSocketClientTransport> = [];

afterEach(async () => {
  while (transports.length > 0) {
    const transport = transports.pop();
    await transport?.close();
  }
});

describe("BunWebSocketServerTransport Bun integration", () => {
  test("starts server and upgrades only configured path", async () => {
    const port = await reservePort();

    const serverTransport = new BunWebSocketServerTransport({
      port,
      path: "/ws",
    });
    transports.push(serverTransport);

    await serverTransport.registerRoutes({
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
      socketAdapter: bunSocketAdapter,
    });
    transports.push(client);

    const value = await client.invoke("health.ping", null);
    expect(value).toBe("pong");
  });

  test("handles request, signal, and feed envelopes end-to-end", async () => {
    const port = await reservePort();
    const seenSignals: Array<unknown> = [];

    const serverTransport = new BunWebSocketServerTransport({ port, path: "/ws" });
    transports.push(serverTransport);

    await serverTransport.registerRoutes({
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
      socketAdapter: bunSocketAdapter,
    });
    transports.push(client);

    await expect(client.invoke("math.double", 21)).resolves.toBe(42);

    await client.invoke("math.notify", { id: 7 });
    await wait(20);
    expect(seenSignals).toEqual([{ id: 7 }]);

    const feedResult = await client.invoke("math.count", { room: "main" });
    await expect(collect(feedResult as AsyncIterable<number>)).resolves.toEqual([1, 2, 3]);
  });
});
