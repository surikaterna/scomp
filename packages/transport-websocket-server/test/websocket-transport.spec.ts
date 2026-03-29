import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  composeScompFragments,
  createScompFragment,
  createScompService,
  type CompiledRoute,
  type CompiledRouter,
} from "@scomp/core";
import { WebSocketClientTransport } from "@scomp/transport-websocket-client";
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

type Harness = {
  httpServer: HttpServer;
  url: string;
  serverTransport: WebSocketServerTransport;
};

async function createHarness(router: CompiledRouter): Promise<Harness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );

  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  const serverTransport = new WebSocketServerTransport({
    server: httpServer,
    outbound: { url },
  });
  await serverTransport.listen(router);

  return {
    httpServer,
    url,
    serverTransport,
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  const transportState = harness.serverTransport as unknown as {
    sockets?: Set<{ terminate?: () => void; close?: () => void }>;
    server?: { close: (callback: (error?: Error) => void) => void };
    outboundTransport?: {
      socket?: { terminate?: () => void; close?: () => void };
    };
  };

  for (const socket of transportState.sockets ?? []) {
    socket.terminate?.();
    socket.close?.();
  }

  transportState.outboundTransport?.socket?.terminate?.();
  transportState.outboundTransport?.socket?.close?.();

  if (transportState.server) {
    await new Promise<void>((resolve) => {
      transportState.server?.close(() => resolve());
    });
  }

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

async function closeClientTransport(
  client: WebSocketClientTransport,
): Promise<void> {
  const state = client as unknown as {
    socket?: { terminate?: () => void; close?: () => void };
  };

  state.socket?.terminate?.();
  state.socket?.close?.();
}

describe("WebSocket transports", () => {
  it("keeps grouped and composed fragment routers transport-compatible", async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const groupedSignals: Array<unknown> = [];
    const grouped = createScompService<UsersContract>("users").implement({
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
    const requestFragment = createScompFragment<UsersContract>("users").implement(
      {
        requests: {
          getUser: async ({ id }: { id: number }) => ({ id, name: `u-${id}` }),
        },
      },
    );
    const signalFragment = createScompFragment<UsersContract>("users").implement(
      {
        signals: {
          notifyLogin: async (payload: { id: number }) => {
            composedSignals.push(payload);
          },
        },
      },
    );
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
    const composed = composeScompFragments(
      requestFragment,
      signalFragment,
      feedFragment,
    );

    const cases = [
      { router: grouped.router, signals: groupedSignals },
      { router: composed.router, signals: composedSignals },
    ];

    for (const { router, signals } of cases) {
      assert.equal(router["users.getUser"].kind, "request");
      assert.equal(router["users.notifyLogin"].kind, "signal");
      assert.equal(router["users.liveUsers"].kind, "feed");

      const harness = await createHarness(router);
      const client = new WebSocketClientTransport({ url: harness.url });

      try {
        const requestResult = await client.request("users.getUser", { id: 7 });
        assert.deepEqual(requestResult, { id: 7, name: "u-7" });

        await client.signal("users.notifyLogin", { id: 7 });
        await wait(15);
        assert.deepEqual(signals, [{ id: 7 }]);

        const feedValues = await collect(client.feed("users.liveUsers", {
          room: "general",
        }));
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
    const client = new WebSocketClientTransport({ url: harness.url });

    try {
      const requestResult = await client.request("math.double", 21);
      assert.equal(requestResult, 42);

      await client.signal("math.notify", { id: 7 });
      await wait(15);
      assert.deepEqual(signals, [{ id: 7 }]);

      const feedValues = await collect(client.feed("math.count", 3));
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
        hashKey: (payload: unknown) =>
          String((payload as { room: string }).room),
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
    const clientA = new WebSocketClientTransport({ url: harness.url });
    const clientB = new WebSocketClientTransport({ url: harness.url });

    try {
      const [valuesA, valuesB] = await Promise.all([
        collect(clientA.feed("prices.live", { room: "alpha" })),
        collect(clientB.feed("prices.live", { room: "alpha" })),
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
      const requestResult = await harness.serverTransport.request("ops.echo", {
        id: 11,
      });
      assert.deepEqual(requestResult, { payload: { id: 11 } });

      await harness.serverTransport.signal("ops.log", { line: "hello" });
      await wait(15);
      assert.deepEqual(signals, [{ line: "hello" }]);

      const values = await collect(
        harness.serverTransport.feed("ops.range", 2),
      );
      assert.deepEqual(values, [1, 2]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("enforces shared security policy for inbound websocket operations", async () => {
    const deniedSignals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      "secure.echo": {
        route: "secure.echo",
        kind: "request",
        handler: async (payload: unknown) => ({ payload }),
      },
      "secure.signal": {
        route: "secure.signal",
        kind: "signal",
        handler: async (payload: unknown) => {
          deniedSignals.push(payload);
        },
      },
    };

    const seen: Array<{ route: string; operation: string; subject?: string }> =
      [];
    const httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = httpServer.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    const transport = new WebSocketServerTransport({
      server: httpServer,
      security: {
        authenticate: ({ meta }) => {
          const auth = meta?.auth as { token?: string } | undefined;
          if (auth?.token === "allow") {
            return { subject: "user:allow" };
          }
          return null;
        },
        authorize: (ctx) => {
          seen.push({
            route: ctx.route,
            operation: ctx.operation,
            subject: ctx.principal?.subject,
          });
          return ctx.principal?.subject === "user:allow";
        },
      },
    });

    await transport.listen(router);

    const deniedClient = new WebSocketClientTransport({
      url,
      meta: { auth: { token: "deny" } },
    });
    const allowedClient = new WebSocketClientTransport({
      url,
      meta: { auth: { token: "allow" } },
    });

    try {
      await assert.rejects(
        () => deniedClient.request("secure.echo", { id: 1 }),
        /not authorized/i,
      );
      const ok = await allowedClient.request("secure.echo", { id: 2 });
      assert.deepEqual(ok, { payload: { id: 2 } });

      await deniedClient.signal("secure.signal", { denied: true });
      await wait(15);
      assert.deepEqual(deniedSignals, []);

      assert.equal(
        seen.some(
          (entry) =>
            entry.route === "secure.echo" && entry.subject === "user:allow",
        ),
        true,
      );
      assert.equal(
        seen.some(
          (entry) =>
            entry.route === "secure.echo" && entry.subject === undefined,
        ),
        true,
      );
    } finally {
      await closeClientTransport(deniedClient);
      await closeClientTransport(allowedClient);
      await closeHarness({ httpServer, url, serverTransport: transport });
    }
  });
});
