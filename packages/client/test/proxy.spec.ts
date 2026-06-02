import { createScompClient } from "../src/proxy";

/**
 * Minimal ITransport implementation that records calls for assertion.
 */
class FakeTransport {
  lastInvoke: { route: string; payload: unknown; options: unknown } | undefined;
  invokeResult: unknown = { result: "ok" };

  registerRoutes() {}
  close() {
    return Promise.resolve();
  }

  async invoke(route: string, payload: unknown, options?: unknown) {
    this.lastInvoke = { route, payload, options };
    return this.invokeResult;
  }
}

function createTestClient(overrides = {}) {
  const transport = new FakeTransport();
  const client = createScompClient({
    transport,
    ...overrides,
  });
  return { transport, client };
}

describe("createScompClient proxy", () => {
  describe("request dispatch", () => {
    it("calls transport.invoke with correct route and payload", async () => {
      const { transport, client } = createTestClient();
      const result = await client.getUser({ id: 42 });

      expect(transport.lastInvoke).toEqual({
        route: "getUser",
        payload: { id: 42 },
        options: undefined,
      });
      expect(result).toEqual({ result: "ok" });
    });

    it("defaults to invoke when no routeHints are provided", async () => {
      const { transport, client } = createTestClient();
      await client.someMethod("hello");

      expect(transport.lastInvoke).toBeDefined();
      expect(transport.lastInvoke!.route).toBe("someMethod");
      expect(transport.lastInvoke!.payload).toBe("hello");
    });
  });

  describe("signal dispatch", () => {
    it("calls transport.invoke regardless of routeHints (routeHints deprecated)", async () => {
      const { transport, client } = createTestClient({
        routeHints: { notifyLogin: "signal" },
      });

      await client.notifyLogin({ userId: 7 });

      expect(transport.lastInvoke).toEqual({
        route: "notifyLogin",
        payload: { userId: 7 },
        options: undefined,
      });
    });
  });

  describe("feed dispatch", () => {
    it("calls transport.invoke regardless of routeHints (routeHints deprecated)", async () => {
      const transport = new FakeTransport();
      const chunks = [{ chunk: 1 }, { chunk: 2 }];
      transport.invokeResult = (async function* () {
        for (const c of chunks) yield c;
      })();

      const client = createScompClient({
        transport,
        routeHints: { liveUsers: "feed" },
      });

      const feed = client.liveUsers({ room: "general" });
      // invoke is called, result is an async iterable
      const collected: unknown[] = [];
      for await (const chunk of feed) {
        collected.push(chunk);
      }

      expect(transport.lastInvoke).toBeDefined();
      expect(transport.lastInvoke!.route).toBe("liveUsers");
      expect(collected).toEqual(chunks);
    });
  });

  describe("option merging precedence", () => {
    it("merges routeOptions → routeOptionResolver → call-site options", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          update: {
            priority: "P2",
            meta: { source: "route-default" },
          },
        },
        routeOptionResolver: ({ route }) => {
          if (route === "update") {
            return { meta: { resolverKey: "resolved" } };
          }
          return undefined;
        },
      });

      await client.update({ data: "value" }, { priority: "P0", meta: { callKey: "call-site" } });

      const opts = transport.lastInvoke!.options as Record<string, unknown>;
      expect(opts.priority).toBe("P0");
      expect(opts.meta).toEqual({
        source: "route-default",
        resolverKey: "resolved",
        callKey: "call-site",
      });
    });

    it("uses only routeOptions when no resolver or call-site options", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          fetch: { priority: "P3" },
        },
      });

      await client.fetch({ id: 1 });

      expect(transport.lastInvoke!.options).toEqual({ priority: "P3" });
    });

    it("uses only resolver when no routeOptions or call-site options", async () => {
      const { transport, client } = createTestClient({
        routeOptionResolver: () => ({ targetLatencyMs: 500 }),
      });

      await client.fetch({ id: 1 });

      expect(transport.lastInvoke!.options).toEqual({ targetLatencyMs: 500 });
    });
  });

  describe("meta propagation", () => {
    it("passes call-site meta through to transport", async () => {
      const { transport, client } = createTestClient();

      await client.doStuff({ x: 1 }, { meta: { traceId: "abc-123" } });

      expect(transport.lastInvoke!.options).toEqual({
        meta: { traceId: "abc-123" },
      });
    });

    it("merges meta from all layers without losing keys", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          action: { meta: { a: "1" } },
        },
        routeOptionResolver: () => ({ meta: { b: "2" } }),
      });

      await client.action({}, { meta: { c: "3" } });

      expect((transport.lastInvoke!.options as Record<string, unknown>).meta).toEqual({
        a: "1",
        b: "2",
        c: "3",
      });
    });
  });

  describe("priority hints", () => {
    it("forwards priority from routeOptions to transport", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          urgent: { priority: "P0", priorityClass: "P0" },
        },
      });

      await client.urgent({ data: true });

      const opts = transport.lastInvoke!.options as Record<string, unknown>;
      expect(opts.priority).toBe("P0");
      expect(opts.priorityClass).toBe("P0");
    });

    it("call-site priority overrides route-level priority", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          task: { priority: "P4" },
        },
      });

      await client.task({}, { priority: "P1" });

      expect((transport.lastInvoke!.options as Record<string, unknown>).priority).toBe("P1");
    });
  });

  describe("nested namespace proxy", () => {
    it("produces dot-separated route path for nested access", async () => {
      const { transport, client } = createTestClient();

      await client.users.getById({ id: 5 });

      expect(transport.lastInvoke).toEqual({
        route: "users.getById",
        payload: { id: 5 },
        options: undefined,
      });
    });

    it("supports deeply nested namespaces", async () => {
      const { transport, client } = createTestClient();

      await client.api.v2.users.list({});

      expect(transport.lastInvoke!.route).toBe("api.v2.users.list");
    });

    it("invokes via transport.invoke even with routeHints (deprecated)", async () => {
      const { transport, client } = createTestClient({
        routeHints: { "events.subscribe": "signal" },
      });

      await client.events.subscribe({ topic: "orders" });

      expect(transport.lastInvoke).toBeDefined();
      expect(transport.lastInvoke!.route).toBe("events.subscribe");
    });
  });

  describe("then property access", () => {
    it("returns a proxy node for .then (string property)", () => {
      const { client } = createTestClient();

      const thenProp = client.then;
      expect(typeof thenProp).toBe("function");
    });
  });

  describe("non-string property access", () => {
    it("returns undefined for Symbol properties", () => {
      const { client } = createTestClient();

      const sym = Symbol("test");
      const value = client[sym];

      expect(value).toBeUndefined();
    });

    it("returns undefined for Symbol.toPrimitive", () => {
      const { client } = createTestClient();

      const value = client[Symbol.toPrimitive];

      expect(value).toBeUndefined();
    });
  });

  describe("feed via invoke", () => {
    it("returns an async iterable when invoke resolves to one", async () => {
      const transport = new FakeTransport();
      transport.invokeResult = (async function* () {
        yield { chunk: 1 };
        yield { chunk: 2 };
      })();

      const client = createScompClient({ transport });
      const feed = client.events({ filter: "all" });
      const chunks: unknown[] = [];
      for await (const chunk of feed) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{ chunk: 1 }, { chunk: 2 }]);
    });
  });

  describe("deadline and targetLatency options", () => {
    it("forwards deadlineAtMs from call-site options", async () => {
      const { transport, client } = createTestClient();

      await client.slowOp({}, { deadlineAtMs: 1000 });

      expect(transport.lastInvoke!.options).toEqual({ deadlineAtMs: 1000 });
    });

    it("forwards targetLatencyMs from routeOptions", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          fast: { targetLatencyMs: 50 },
        },
      });

      await client.fast({});

      expect(transport.lastInvoke!.options).toEqual({ targetLatencyMs: 50 });
    });
  });

  describe("no options passed", () => {
    it("omits options when none are provided at any level", async () => {
      const { transport, client } = createTestClient();

      await client.plain({ data: 1 });

      expect(transport.lastInvoke!.options).toBeUndefined();
    });
  });
});
