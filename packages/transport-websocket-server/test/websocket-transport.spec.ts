import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type CompiledRoute, type CompiledRouter } from "@scomp/core";
import { WebSocketBrowserTransport } from "@scomp/transport-websocket-browser";
import { WebSocketClientTransport } from "@scomp/transport-websocket-client";
import { WebSocketServerTransport } from "../src";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(
  iterable: AsyncIterable<number>,
): Promise<Array<number>> {
  const values: Array<number> = [];
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
  it("passes invocation options metadata through browser outbound envelopes", async () => {
    const observed: Array<{
      route: string;
      op: string;
      meta?: Record<string, unknown>;
    }> = [];

    const router: Record<string, CompiledRoute> = {
      "meta.request": {
        route: "meta.request",
        kind: "request",
        handler: async (payload: unknown) => payload,
      },
      "meta.signal": {
        route: "meta.signal",
        kind: "signal",
        handler: async () => undefined,
      },
      "meta.feed": {
        route: "meta.feed",
        kind: "feed",
        strategy: "fanout",
        handler: async function* () {
          yield { ok: true };
        },
      },
    };

    const harness = await createHarness(router);

    const browser = new WebSocketBrowserTransport({
      url: harness.url,
      meta: { traceId: "trace-browser" },
      security: {
        authorize: (ctx) => {
          observed.push({
            route: ctx.route,
            op: ctx.operation,
            meta: ctx.meta as Record<string, unknown> | undefined,
          });
          return true;
        },
      },
    });

    try {
      await browser.request("meta.request", { id: 1 }, {
        meta: { tenantId: "tenant-r" },
        priority: "P0",
        priorityClass: "P1",
        deadlineAtMs: 111,
        targetLatencyMs: 22,
      });

      await browser.signal("meta.signal", { id: 2 }, {
        meta: { tenantId: "tenant-s" },
        priority: "P2",
        priorityClass: "P3",
        deadlineAtMs: 222,
        targetLatencyMs: 33,
      });

      const feedIterator = browser
        .feed("meta.feed", { id: 3 }, {
          meta: { tenantId: "tenant-f" },
          priority: "P1",
          priorityClass: "P2",
          deadlineAtMs: 333,
          targetLatencyMs: 44,
        })
        [Symbol.asyncIterator]();

      await feedIterator.next();
      await feedIterator.return?.(undefined);

      const requestMeta = observed.find(
        (entry) => entry.route === "meta.request" && entry.op === "request",
      )?.meta;
      assert.equal(requestMeta?.traceId, "trace-browser");
      assert.equal(requestMeta?.tenantId, "tenant-r");
      assert.equal(requestMeta?.priority, "P0");
      assert.equal(requestMeta?.priorityClass, "P1");
      assert.equal(requestMeta?.deadlineAtMs, 111);
      assert.equal(requestMeta?.targetLatencyMs, 22);

      const signalMeta = observed.find(
        (entry) => entry.route === "meta.signal" && entry.op === "signal",
      )?.meta;
      assert.equal(signalMeta?.traceId, "trace-browser");
      assert.equal(signalMeta?.tenantId, "tenant-s");
      assert.equal(signalMeta?.priority, "P2");
      assert.equal(signalMeta?.priorityClass, "P3");
      assert.equal(signalMeta?.deadlineAtMs, 222);
      assert.equal(signalMeta?.targetLatencyMs, 33);

      const feedStartMeta = observed.find(
        (entry) => entry.route === "meta.feed" && entry.op === "feed_start",
      )?.meta;
      assert.equal(feedStartMeta?.traceId, "trace-browser");
      assert.equal(feedStartMeta?.tenantId, "tenant-f");
      assert.equal(feedStartMeta?.priority, "P1");
      assert.equal(feedStartMeta?.priorityClass, "P2");
      assert.equal(feedStartMeta?.deadlineAtMs, 333);
      assert.equal(feedStartMeta?.targetLatencyMs, 44);

      const feedStopMeta = observed.find(
        (entry) => entry.route === "meta.feed" && entry.op === "feed_stop",
      )?.meta;
      assert.deepEqual(feedStopMeta, feedStartMeta);
    } finally {
      await closeHarness(harness);
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
