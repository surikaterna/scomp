import {
  ScompFrameworkMethods,
  type CompiledRoute,
} from "@scomp/core";
import type {
  ScompFeedChunkEnvelope,
  ScompTransportResponseEnvelope,
  ScompTransportSecurityPolicy,
} from "@scomp/types";
import {
  WebSocketServerRuntime,
  type RuntimeSocket,
  type TransportMessage,
  type WebSocketServerRuntimeConfig,
} from "../src";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake socket implementing RuntimeSocket. */
class FakeSocket implements RuntimeSocket {
  readyState = 1; // OPEN
  sentPayloads: string[] = [];
  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

/** Collect replies and feed chunks sent through the runtime config. */
type Collector = {
  replies: Array<{ socket: FakeSocket; response: ScompTransportResponseEnvelope }>;
  feedChunks: Array<{ socket: FakeSocket; chunk: ScompFeedChunkEnvelope }>;
};

function createCollector(): Collector {
  return { replies: [], feedChunks: [] };
}

function createConfig(
  overrides: Partial<WebSocketServerRuntimeConfig<FakeSocket>> = {},
  collector: Collector = createCollector(),
): WebSocketServerRuntimeConfig<FakeSocket> & { collector: Collector } {
  const principals = new WeakMap<FakeSocket, unknown>();
  return {
    invokeRoute: async (route, message) => route.handler(message.payload),
    isSocketOpen: (socket) => socket.readyState === 1,
    onReply: (socket, response) => {
      collector.replies.push({ socket, response });
    },
    onFeedChunk: (socket, chunk) => {
      collector.feedChunks.push({ socket, chunk });
    },
    onFeedExchange: (hash) => `exchange:${hash}`,
    getSocketPrincipal: (socket) => principals.get(socket) as any,
    setSocketPrincipal: (socket, principal) => {
      principals.set(socket, principal);
    },
    collector,
    ...overrides,
  };
}

function makeRequest(
  route: string,
  payload?: unknown,
  extra: Partial<TransportMessage> = {},
): TransportMessage {
  return {
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    route,
    op: "request",
    payload,
    ...extra,
  } as TransportMessage;
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function repliesFor(collector: Collector, id: string) {
  return collector.replies
    .filter((r) => r.response.id === id)
    .map((r) => r.response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocketServerRuntime", () => {
  // ---- Request dispatch ---------------------------------------------------
  describe("request dispatch", () => {
    it("routes a request and replies with result", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "math.double": {
          route: "math.double",
          kind: "request",
          handler: (n: unknown) => (n as number) * 2,
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("math.double", 21);

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).payload).toBe(42);
    });

    it("replies with handler error when handler throws", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "svc.fail": {
          route: "svc.fail",
          kind: "request",
          handler: () => {
            throw new Error("boom");
          },
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("svc.fail");

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).error).toBe("boom");
    });
  });

  // ---- Signal dispatch ----------------------------------------------------
  describe("signal dispatch", () => {
    it("invokes signal handler without sending a reply", async () => {
      const signals: unknown[] = [];
      const cfg = createConfig({
        invokeRoute: async (route, message) => {
          signals.push(message.payload);
          return route.handler(message.payload);
        },
      });
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "audit.log": {
          route: "audit.log",
          kind: "signal",
          handler: () => undefined,
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("audit.log", { action: "login" }, { op: "signal" });

      await runtime.handleIncoming(socket, msg);

      expect(signals).toEqual([{ action: "login" }]);
      // Signals are fire-and-forget: no reply sent
      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(0);
    });
  });

  // ---- Route not found ----------------------------------------------------
  describe("route not found", () => {
    it("replies with ROUTE_NOT_FOUND error", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({});

      const socket = new FakeSocket();
      const msg = makeRequest("missing.route");

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).code).toBe("ROUTE_NOT_FOUND");
      expect((responses[0] as any).error).toContain("missing.route");
    });
  });

  // ---- Feed lifecycle -----------------------------------------------------
  describe("feed lifecycle", () => {
    it("replies with feed hash, broadcasts chunks, then done", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "prices.live": {
          route: "prices.live",
          kind: "feed",
          strategy: "fanout",
          handler: async function* () {
            yield 10;
            yield 20;
          },
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("prices.live", {});

      await runtime.handleIncoming(socket, msg);

      // Initial reply contains the feed hash and exchange
      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      const feedResponse = (responses[0] as any).payload;
      expect(feedResponse).toHaveProperty("feed");
      expect(feedResponse).toHaveProperty("exchange");

      // Wait for setImmediate + async iteration
      await flushImmediate();
      // Give time for async generator to complete
      await new Promise((r) => setTimeout(r, 50));

      const chunks = cfg.collector.feedChunks.filter(
        (c) => c.chunk.feed === feedResponse.feed,
      );
      const types = chunks.map((c) => c.chunk.type);
      expect(types).toEqual(["next", "next", "done"]);

      const payloads = chunks
        .filter((c) => c.chunk.type === "next")
        .map((c) => c.chunk.payload);
      expect(payloads).toEqual([10, 20]);
    });

    it("shares a running feed across multiple subscribers", async () => {
      let starts = 0;
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "prices.live": {
          route: "prices.live",
          kind: "feed",
          strategy: "fanout",
          hashKey: () => "same-hash",
          handler: async function* () {
            starts += 1;
            await new Promise((r) => setTimeout(r, 30));
            yield 1;
          },
        },
      });

      const socketA = new FakeSocket();
      const socketB = new FakeSocket();
      const msgA = makeRequest("prices.live", {});
      const msgB = makeRequest("prices.live", {});

      await runtime.handleIncoming(socketA, msgA);
      // Second subscription before iteration completes
      await runtime.handleIncoming(socketB, msgB);

      await flushImmediate();
      await new Promise((r) => setTimeout(r, 80));

      // Handler should only start once
      expect(starts).toBe(1);

      // Both sockets should receive the feed chunk
      const socketsWithChunks = new Set(
        cfg.collector.feedChunks
          .filter((c) => c.chunk.type === "next")
          .map((c) => c.socket),
      );
      expect(socketsWithChunks.has(socketA)).toBe(true);
      expect(socketsWithChunks.has(socketB)).toBe(true);
    });
  });

  // ---- Feed unsubscribe ---------------------------------------------------
  describe("feed unsubscribe", () => {
    it("removes subscriber and aborts when last subscriber leaves", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "stream.events": {
          route: "stream.events",
          kind: "feed",
          strategy: "fanout",
          hashKey: () => "unsub-hash",
          handler: async function* () {
            // Long-running feed
            await new Promise((r) => setTimeout(r, 2000));
            yield "never";
          },
        },
      });

      const socket = new FakeSocket();
      const subMsg = makeRequest("stream.events", {});
      await runtime.handleIncoming(socket, subMsg);

      const subReply = repliesFor(cfg.collector, subMsg.id!);
      const feedHash = (subReply[0] as any).payload.feed;

      // Send unsubscribe signal
      const unsubMsg: TransportMessage = {
        id: `unsub-${Date.now()}`,
        route: "stream.events",
        op: "signal",
        method: ScompFrameworkMethods.UNSUBSCRIBE,
        feed: feedHash,
      };
      await runtime.handleIncoming(socket, unsubMsg);

      // Unsubscribe replies with { ok: true }
      const unsubReply = repliesFor(cfg.collector, unsubMsg.id!);
      expect(unsubReply).toHaveLength(1);
      expect((unsubReply[0] as any).payload).toEqual({ ok: true });
    });
  });

  // ---- Security: unauthorized request -------------------------------------
  describe("security", () => {
    it("rejects unauthorized requests with UNAUTHORIZED error", async () => {
      const security: ScompTransportSecurityPolicy = {
        authorize: () => false,
      };
      const cfg = createConfig({ security });
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "admin.reset": {
          route: "admin.reset",
          kind: "request",
          handler: () => "should not reach",
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("admin.reset", {});

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).code).toBe("UNAUTHORIZED");
      expect((responses[0] as any).error).toContain("not authorized");
    });

    it("allows requests when authorize returns true", async () => {
      const security: ScompTransportSecurityPolicy = {
        authenticate: () => ({ subject: "admin" }),
        authorize: (ctx) => ctx.principal?.subject === "admin",
      };
      const cfg = createConfig({ security });
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "admin.reset": {
          route: "admin.reset",
          kind: "request",
          handler: () => "ok",
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("admin.reset", {});

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).payload).toBe("ok");
    });
  });

  // ---- Socket disconnect cleanup ------------------------------------------
  describe("socket disconnect cleanup", () => {
    it("aborts feeds when detached socket was last subscriber", async () => {
      const yieldedValues: number[] = [];
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "data.stream": {
          route: "data.stream",
          kind: "feed",
          strategy: "fanout",
          hashKey: () => "detach-hash",
          handler: async function* () {
            for (let i = 0; i < 100; i++) {
              await new Promise((r) => setTimeout(r, 10));
              yieldedValues.push(i);
              yield i;
            }
          },
        },
      });

      const socket = new FakeSocket();
      const msg = makeRequest("data.stream", {});
      await runtime.handleIncoming(socket, msg);

      // Let the feed start and emit a couple values
      await flushImmediate();
      await new Promise((r) => setTimeout(r, 40));

      // Detach — should abort the feed since this is the last subscriber
      runtime.detachSocketFromFeeds(socket);

      const countAtDetach = yieldedValues.length;

      // Wait a bit to verify the generator stops
      await new Promise((r) => setTimeout(r, 80));

      // The generator should have stopped shortly after detach, not continued
      // to 100. Allow 1-2 extra yields from timing.
      expect(yieldedValues.length).toBeLessThan(countAtDetach + 3);
      expect(yieldedValues.length).toBeLessThan(100);
    });

    it("keeps feed alive when other subscribers remain", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "data.stream": {
          route: "data.stream",
          kind: "feed",
          strategy: "fanout",
          hashKey: () => "multi-hash",
          handler: async function* () {
            await new Promise((r) => setTimeout(r, 40));
            yield 99;
          },
        },
      });

      const socketA = new FakeSocket();
      const socketB = new FakeSocket();
      const msgA = makeRequest("data.stream", {});
      const msgB = makeRequest("data.stream", {});

      await runtime.handleIncoming(socketA, msgA);
      await runtime.handleIncoming(socketB, msgB);

      // Detach only socketA
      runtime.detachSocketFromFeeds(socketA);

      // Wait for feed to complete naturally
      await flushImmediate();
      await new Promise((r) => setTimeout(r, 100));

      // socketB should still receive chunks (socketA should not after detach)
      const chunksForB = cfg.collector.feedChunks.filter(
        (c) => c.socket === socketB && c.chunk.type === "next",
      );
      expect(chunksForB.length).toBeGreaterThanOrEqual(1);
      expect(chunksForB[0].chunk.payload).toBe(99);
    });
  });

  // ---- Controller method routing ------------------------------------------
  describe("controller method routing", () => {
    it("returns FEED_NOT_FOUND for unknown feed hash", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "svc.feed": {
          route: "svc.feed",
          kind: "feed",
          handler: async function* () {
            yield 1;
          },
        },
      });

      const socket = new FakeSocket();
      const msg: TransportMessage = {
        id: "ctrl-1",
        route: "svc.feed",
        op: "request",
        feed: "nonexistent-hash",
        method: "doStuff",
      };

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, "ctrl-1");
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).code).toBe("FEED_NOT_FOUND");
    });

    it("returns CONTROLLER_NOT_FOUND for framework-prefixed methods", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "svc.feed": {
          route: "svc.feed",
          kind: "feed",
          handler: async function* () {
            yield 1;
          },
        },
      });

      // We need to create a feed first to get a valid feed hash
      const socket = new FakeSocket();
      const subMsg = makeRequest("svc.feed", {});
      await runtime.handleIncoming(socket, subMsg);
      const feedHash = (repliesFor(cfg.collector, subMsg.id!)[0] as any)
        .payload.feed;

      const msg: TransportMessage = {
        id: "ctrl-2",
        route: "svc.feed",
        op: "request",
        feed: feedHash,
        method: "__scomp.customFramework",
      };

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, "ctrl-2");
      expect(responses).toHaveLength(1);
      expect((responses[0] as any).code).toBe("CONTROLLER_NOT_FOUND");
    });
  });

  // ---- No reply when socket is closed -------------------------------------
  describe("closed socket handling", () => {
    it("does not reply when socket is not open", async () => {
      const cfg = createConfig();
      const runtime = new WebSocketServerRuntime(cfg);
      runtime.setRouter({
        "svc.echo": {
          route: "svc.echo",
          kind: "request",
          handler: (p: unknown) => p,
        },
      });

      const socket = new FakeSocket();
      socket.readyState = 3; // CLOSED
      const msg = makeRequest("svc.echo", "hello");

      await runtime.handleIncoming(socket, msg);

      const responses = repliesFor(cfg.collector, msg.id!);
      expect(responses).toHaveLength(0);
    });
  });
});
