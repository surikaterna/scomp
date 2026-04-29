import { createScompClient } from "../src/proxy";

/**
 * Minimal ITransport implementation that records calls for assertion.
 */
class FakeTransport {
  lastRequest;
  lastSignal;
  lastFeed;
  requestResult = { result: "ok" };
  feedChunks = [{ chunk: 1 }, { chunk: 2 }];

  registerRoutes() {}
  close() {
    return Promise.resolve();
  }

  async request(route, payload, options) {
    this.lastRequest = { route, payload, options };
    return this.requestResult;
  }

  async signal(route, payload, options) {
    this.lastSignal = { route, payload, options };
  }

  async *feed(route, payload, options) {
    this.lastFeed = { route, payload, options };
    for (const chunk of this.feedChunks) {
      yield chunk;
    }
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
    it("calls transport.request with correct route and payload", async () => {
      const { transport, client } = createTestClient();
      const result = await client.getUser({ id: 42 });

      expect(transport.lastRequest).toEqual({
        route: "getUser",
        payload: { id: 42 },
        options: undefined,
      });
      expect(result).toEqual({ result: "ok" });
    });

    it("defaults to request when no routeHints are provided", async () => {
      const { transport, client } = createTestClient();
      await client.someMethod("hello");

      expect(transport.lastRequest).toBeDefined();
      expect(transport.lastRequest.route).toBe("someMethod");
      expect(transport.lastRequest.payload).toBe("hello");
    });
  });

  describe("signal dispatch", () => {
    it("calls transport.signal when routeHints mark the method as signal", async () => {
      const { transport, client } = createTestClient({
        routeHints: { notifyLogin: "signal" },
      });

      await client.notifyLogin({ userId: 7 });

      expect(transport.lastSignal).toEqual({
        route: "notifyLogin",
        payload: { userId: 7 },
        options: undefined,
      });
      expect(transport.lastRequest).toBeUndefined();
    });
  });

  describe("feed dispatch", () => {
    it("calls transport.feed and returns an async iterable when routeHints mark feed", async () => {
      const { transport, client } = createTestClient({
        routeHints: { liveUsers: "feed" },
      });

      const feed = client.liveUsers({ room: "general" });
      const chunks = [];
      for await (const chunk of feed) {
        chunks.push(chunk);
      }

      expect(transport.lastFeed).toBeDefined();
      expect(transport.lastFeed.route).toBe("liveUsers");
      expect(transport.lastFeed.payload).toEqual({ room: "general" });
      expect(chunks).toEqual([{ chunk: 1 }, { chunk: 2 }]);
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

      const opts = transport.lastRequest.options;
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

      expect(transport.lastRequest.options).toEqual({ priority: "P3" });
    });

    it("uses only resolver when no routeOptions or call-site options", async () => {
      const { transport, client } = createTestClient({
        routeOptionResolver: () => ({ targetLatencyMs: 500 }),
      });

      await client.fetch({ id: 1 });

      expect(transport.lastRequest.options).toEqual({ targetLatencyMs: 500 });
    });
  });

  describe("meta propagation", () => {
    it("passes call-site meta through to transport", async () => {
      const { transport, client } = createTestClient();

      await client.doStuff({ x: 1 }, { meta: { traceId: "abc-123" } });

      expect(transport.lastRequest.options).toEqual({
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

      expect(transport.lastRequest.options.meta).toEqual({
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

      expect(transport.lastRequest.options.priority).toBe("P0");
      expect(transport.lastRequest.options.priorityClass).toBe("P0");
    });

    it("call-site priority overrides route-level priority", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          task: { priority: "P4" },
        },
      });

      await client.task({}, { priority: "P1" });

      expect(transport.lastRequest.options.priority).toBe("P1");
    });
  });

  describe("nested namespace proxy", () => {
    it("produces dot-separated route path for nested access", async () => {
      const { transport, client } = createTestClient();

      await client.users.getById({ id: 5 });

      expect(transport.lastRequest).toEqual({
        route: "users.getById",
        payload: { id: 5 },
        options: undefined,
      });
    });

    it("supports deeply nested namespaces", async () => {
      const { transport, client } = createTestClient();

      await client.api.v2.users.list({});

      expect(transport.lastRequest.route).toBe("api.v2.users.list");
    });

    it("applies routeHints to nested routes", async () => {
      const { transport, client } = createTestClient({
        routeHints: { "events.subscribe": "signal" },
      });

      await client.events.subscribe({ topic: "orders" });

      expect(transport.lastSignal).toBeDefined();
      expect(transport.lastSignal.route).toBe("events.subscribe");
    });
  });

  describe("then property access", () => {
    it("returns a proxy node for .then (string property)", () => {
      const { client } = createTestClient();

      // The proxy treats 'then' like any other string property — it returns
      // a new proxy node (which is a callable function). This means
      // `await proxy` will hang because the runtime sees .then as a
      // thenable. Consumers should call methods directly, not await the proxy.
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

  describe("controlled feed controller proxy", () => {
    it("returns an object with async-iterable and controller proxy", async () => {
      const { client } = createTestClient({
        routeHints: { chat: "feed" },
      });

      const feed = client.chat({ room: "test" });

      // The feed should be async-iterable
      expect(feed[Symbol.asyncIterator]).toBeDefined();

      // The feed should have a controller property
      expect(feed.controller).toBeDefined();
    });

    it("controller proxy dispatches requests with feed and method options", async () => {
      const { transport, client } = createTestClient({
        routeHints: { chat: "feed" },
      });

      const feed = client.chat({ room: "test" });

      // Call a controller method
      await feed.controller.sendMessage({ text: "hello" });

      // Controller methods go through transport.request with feed/method metadata
      expect(transport.lastRequest).toBeDefined();
      expect(transport.lastRequest.route).toBe("chat");
      expect(transport.lastRequest.payload).toEqual({ text: "hello" });
      expect(transport.lastRequest.options).toBeDefined();
      expect(transport.lastRequest.options.method).toBe("sendMessage");
      expect(typeof transport.lastRequest.options.feed).toBe("string");
    });

    it("controller proxy dispatches different methods correctly", async () => {
      const { transport, client } = createTestClient({
        routeHints: { stream: "feed" },
      });

      const feed = client.stream({ channel: "alpha" });

      await feed.controller.pause({ reason: "buffering" });
      expect(transport.lastRequest.options.method).toBe("pause");

      await feed.controller.resume({});
      expect(transport.lastRequest.options.method).toBe("resume");
    });

    it("feed data can be consumed via async iteration", async () => {
      const { client } = createTestClient({
        routeHints: { events: "feed" },
      });

      const feed = client.events({ filter: "all" });
      const chunks = [];
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

      expect(transport.lastRequest.options).toEqual({ deadlineAtMs: 1000 });
    });

    it("forwards targetLatencyMs from routeOptions", async () => {
      const { transport, client } = createTestClient({
        routeOptions: {
          fast: { targetLatencyMs: 50 },
        },
      });

      await client.fast({});

      expect(transport.lastRequest.options).toEqual({ targetLatencyMs: 50 });
    });
  });

  describe("no options passed", () => {
    it("omits options when none are provided at any level", async () => {
      const { transport, client } = createTestClient();

      await client.plain({ data: 1 });

      expect(transport.lastRequest.options).toBeUndefined();
    });
  });
});
