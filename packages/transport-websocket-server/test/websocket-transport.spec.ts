import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  composeScompFragments,
  createContractToken,
  createScompFragment,
  createScompService,
  type CompiledRoute,
  type CompiledRouter,
} from "@scompr/core";
import { WebSocketClientTransport, createNodeSocketAdapterFactory } from "@scompr/transport-websocket-client";
import { NodeWebSocketServerTransport } from "../src/node";

const nodeSocketAdapter = createNodeSocketAdapterFactory();

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

type Harness = {
  httpServer: HttpServer;
  url: string;
  serverTransport: NodeWebSocketServerTransport;
};

async function createHarness(router: CompiledRouter): Promise<Harness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));

  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  const serverTransport = new NodeWebSocketServerTransport({
    server: httpServer,
    outbound: { url },
  });
  await serverTransport.registerRoutes(router);

  return {
    httpServer,
    url,
    serverTransport,
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.serverTransport.close();

  await new Promise<void>((resolve, reject) => {
    harness.httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeClientTransport(client: WebSocketClientTransport): Promise<void> {
  await client.close();
}

describe("WebSocket transports (Node)", () => {
  it("keeps grouped and composed fragment routers transport-compatible", async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const groupedSignals: Array<unknown> = [];
    const grouped = createScompService<UsersContract>(createContractToken("users")).implement({
      requests: {
        getUser: async ({ id }: { id: number }) => ({ id, name: `u-${id}` }),
      },
      signals: {
        notifyLogin: async (payload: { id: number }) => {
          groupedSignals.push(payload);
        },
      },
      feeds: {
        liveUsers: {
          strategy: "fanout",
          hashKey: ({ room }: { room: string }) => room,
          handler: async function* () {
            yield { id: 1 };
            yield { id: 2 };
          },
        },
      },
    });

    const composedSignals: Array<unknown> = [];
    const requestFragment = createScompFragment<UsersContract>("users").implement({
      requests: {
        getUser: async ({ id }: { id: number }) => ({ id, name: `u-${id}` }),
      },
    });
    const signalFragment = createScompFragment<UsersContract>("users").implement({
      signals: {
        notifyLogin: async (payload: { id: number }) => {
          composedSignals.push(payload);
        },
      },
    });
    const feedFragment = createScompFragment<UsersContract>("users").implement({
      feeds: {
        liveUsers: {
          strategy: "fanout",
          hashKey: ({ room }: { room: string }) => room,
          handler: async function* () {
            yield { id: 1 };
            yield { id: 2 };
          },
        },
      },
    });
    const composed = composeScompFragments(requestFragment, signalFragment, feedFragment);

    const cases = [
      { router: grouped.router, signals: groupedSignals },
      { router: composed.router, signals: composedSignals },
    ];

    for (const { router, signals } of cases) {
      assert.equal(router["users.getUser"].kind, "request");
      assert.equal(router["users.notifyLogin"].kind, "signal");
      assert.equal(router["users.liveUsers"].kind, "feed");

      const harness = await createHarness(router);
      const client = new WebSocketClientTransport({ url: harness.url, socketAdapter: nodeSocketAdapter });

      try {
        const requestResult = await client.invoke("users.getUser", { id: 7 });
        assert.deepEqual(requestResult, { id: 7, name: "u-7" });

        await client.invoke("users.notifyLogin", { id: 7 });
        await wait(15);
        assert.deepEqual(signals, [{ id: 7 }]);

        const feedValues = await collect(
          (await client.invoke("users.liveUsers", {
            room: "general",
          })) as AsyncIterable<{ id: number }>,
        );
        assert.deepEqual(feedValues, [{ id: 1 }, { id: 2 }]);
      } finally {
        await closeClientTransport(client);
        await closeHarness(harness);
      }
    }
  });

  it("supports request, signal, and feed end-to-end", async () => {
    const signals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      "math.double": {
        route: "math.double",
        kind: "request",
        handler: async (value: number) => value * 2,
      },
      "math.notify": {
        route: "math.notify",
        kind: "signal",
        handler: async (payload: unknown) => {
          signals.push(payload);
        },
      },
      "math.count": {
        route: "math.count",
        kind: "feed",
        strategy: "fanout",
        handler: async function* (limit: number) {
          for (let value = 1; value <= limit; value += 1) {
            yield value;
          }
        },
      },
    };

    const harness = await createHarness(router);
    const client = new WebSocketClientTransport({ url: harness.url, socketAdapter: nodeSocketAdapter });

    try {
      const requestResult = await client.invoke("math.double", 21);
      assert.equal(requestResult, 42);

      await client.invoke("math.notify", { id: 7 });
      await wait(15);
      assert.deepEqual(signals, [{ id: 7 }]);

      const feedValues = await collect((await client.invoke("math.count", 3)) as AsyncIterable<number>);
      assert.deepEqual(feedValues, [1, 2, 3]);
    } finally {
      await closeClientTransport(client);
      await closeHarness(harness);
    }
  });

  it("shares fanout feeds by hash across subscribers", async () => {
    let feedStarts = 0;

    const router: Record<string, CompiledRoute> = {
      "prices.live": {
        route: "prices.live",
        kind: "feed",
        strategy: "fanout",
        hashKey: (payload: unknown) => String((payload as { room: string }).room),
        handler: async function* () {
          feedStarts += 1;
          await wait(20);
          yield 1;
          await wait(10);
          yield 2;
          await wait(10);
          yield 3;
        },
      },
    };

    const harness = await createHarness(router);
    const clientA = new WebSocketClientTransport({ url: harness.url, socketAdapter: nodeSocketAdapter });
    const clientB = new WebSocketClientTransport({ url: harness.url, socketAdapter: nodeSocketAdapter });

    try {
      const [valuesA, valuesB] = await Promise.all([
        collect((await clientA.invoke("prices.live", { room: "alpha" })) as AsyncIterable<number>),
        collect((await clientB.invoke("prices.live", { room: "alpha" })) as AsyncIterable<number>),
      ]);

      assert.deepEqual(valuesA, [1, 2, 3]);
      assert.deepEqual(valuesB, [1, 2, 3]);
      assert.equal(feedStarts, 1);
    } finally {
      await closeClientTransport(clientA);
      await closeClientTransport(clientB);
      await closeHarness(harness);
    }
  });

  it("supports outbound request, signal, and feed from server transport", async () => {
    const signals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      "ops.echo": {
        route: "ops.echo",
        kind: "request",
        handler: async (payload: unknown) => ({ payload }),
      },
      "ops.log": {
        route: "ops.log",
        kind: "signal",
        handler: async (payload: unknown) => {
          signals.push(payload);
        },
      },
      "ops.range": {
        route: "ops.range",
        kind: "feed",
        strategy: "fanout",
        handler: async function* (limit: number) {
          for (let value = 1; value <= limit; value += 1) {
            yield value;
          }
        },
      },
    };

    const harness = await createHarness(router);

    try {
      const requestResult = await harness.serverTransport.invoke("ops.echo", {
        id: 11,
      });
      assert.deepEqual(requestResult, { payload: { id: 11 } });

      await harness.serverTransport.invoke("ops.log", { line: "hello" });
      await wait(15);
      assert.deepEqual(signals, [{ line: "hello" }]);

      const values = await collect((await harness.serverTransport.invoke("ops.range", 2)) as AsyncIterable<number>);
      assert.deepEqual(values, [1, 2]);
    } finally {
      await closeHarness(harness);
    }
  });
});
