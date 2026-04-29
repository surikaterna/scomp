import assert from "node:assert/strict";
import type { ScompTransportRequestEnvelope, ScompTransportResponseEnvelope } from "@scomp/types";
import {
  SocketDisconnectedError,
  RequestTimeoutError,
  InFlightLimitError,
  FeedBackpressureError,
  ConnectionTimeoutError,
  WebSocketClientTransport,
  type ISocketAdapter,
  type SocketAdapterFactory,
  type WebSocketTransportEvent,
  type WebSocketReconnectConfig,
} from "../src";

// ---------------------------------------------------------------------------
// FakeSocketAdapter — in-memory ISocketAdapter for testing
// ---------------------------------------------------------------------------

class FakeSocketAdapter implements ISocketAdapter {
  readyState = 0; // CONNECTING

  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: unknown) => void> = [];
  private readonly sent: Array<string>;

  constructor(sent: Array<string>, autoOpen = true) {
    this.sent = sent;
    this.autoOpen = autoOpen;
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1; // OPEN
        for (const h of this.openHandlers) h();
      });
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    for (const h of this.closeHandlers) h();
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }
  onMessage(handler: (text: string) => void): void {
    this.messageHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.push(handler);
  }

  removeAllHandlers(): void {
    this.openHandlers = [];
    this.messageHandlers = [];
    this.closeHandlers = [];
    this.errorHandlers = [];
  }

  // --- Test helpers ---
  emitOpen(): void {
    this.readyState = 1;
    for (const h of this.openHandlers) h();
  }
  emitMessage(text: string): void {
    for (const h of this.messageHandlers) h(text);
  }
  emitClose(): void {
    this.readyState = 3;
    for (const h of this.closeHandlers) h();
  }
  emitError(error: unknown): void {
    for (const h of this.errorHandlers) h(error);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  transport: WebSocketClientTransport;
  sent: Array<string>;
  getSocket: () => FakeSocketAdapter;
  getAllSockets: () => FakeSocketAdapter[];
}

function createHarness(options?: {
  meta?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxInFlightRequests?: number;
  feedBufferHighWaterMark?: number;
  reconnect?: WebSocketReconnectConfig;
  onEvent?: (event: WebSocketTransportEvent) => void;
  /** When true, socket adapter will not auto-open. */
  manualOpen?: boolean;
  /** Factory override for advanced scenarios (reconnect failures). */
  socketFactory?: SocketAdapterFactory;
}): Harness {
  const sent: Array<string> = [];
  const sockets: FakeSocketAdapter[] = [];

  const defaultFactory: SocketAdapterFactory = (_url, _protocols) => {
    const s = new FakeSocketAdapter(sent, !options?.manualOpen);
    sockets.push(s);
    return s;
  };

  const transport = new WebSocketClientTransport({
    url: "ws://example.test",
    meta: options?.meta,
    socketAdapter: options?.socketFactory ?? defaultFactory,
    requestTimeoutMs: options?.requestTimeoutMs,
    connectionTimeoutMs: options?.connectionTimeoutMs,
    maxInFlightRequests: options?.maxInFlightRequests,
    feedBufferHighWaterMark: options?.feedBufferHighWaterMark,
    reconnect: options?.reconnect,
    onEvent: options?.onEvent,
  });

  return {
    transport,
    sent,
    getSocket: () => {
      if (sockets.length === 0) throw new Error("Expected socket to initialize");
      return sockets[sockets.length - 1];
    },
    getAllSockets: () => sockets,
  };
}

function parseEnvelope(payload: string): ScompTransportRequestEnvelope {
  return JSON.parse(payload) as ScompTransportRequestEnvelope;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocketClientTransport (unified)", () => {
  it("includes invocation options in request envelope metadata", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-request",
        tags: { source: "browser" },
      },
    });

    const pending = harness.transport.request(
      "users.get",
      { id: 1 },
      {
        meta: { tenantId: "tenant-a" },
        priority: "P0",
        priorityClass: "P1",
        deadlineAtMs: 500,
        targetLatencyMs: 20,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const outbound = parseEnvelope(harness.sent[0]);
    assert.equal(outbound.route, "users.get");
    assert.equal(outbound.op, "request");
    assert.equal(outbound.meta?.traceId, "trace-request");
    assert.equal(outbound.meta?.tenantId, "tenant-a");
    assert.equal(outbound.meta?.priority, "P0");
    assert.equal(outbound.meta?.priorityClass, "P1");
    assert.equal(outbound.meta?.deadlineAtMs, 500);
    assert.equal(outbound.meta?.targetLatencyMs, 20);
    assert.deepEqual(outbound.meta?.tags, { source: "browser" });

    harness.getSocket().emitMessage(
      JSON.stringify({
        id: outbound.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    );

    assert.deepEqual(await pending, { ok: true });
  });

  it("includes invocation options in signal envelopes", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-signal",
      },
    });

    await harness.transport.signal(
      "users.notify",
      { id: 2 },
      {
        meta: { tenantId: "tenant-s" },
        priority: "P2",
        priorityClass: "P3",
        deadlineAtMs: 1000,
        targetLatencyMs: 50,
      },
    );

    const outbound = parseEnvelope(harness.sent[0]);
    assert.equal(outbound.op, "signal");
    assert.equal(outbound.meta?.traceId, "trace-signal");
    assert.equal(outbound.meta?.tenantId, "tenant-s");
    assert.equal(outbound.meta?.priority, "P2");
    assert.equal(outbound.meta?.priorityClass, "P3");
    assert.equal(outbound.meta?.deadlineAtMs, 1000);
    assert.equal(outbound.meta?.targetLatencyMs, 50);
  });

  it("uses identical metadata for feed start and sends unsubscribe signal", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-feed",
      },
    });

    const iterator = harness.transport
      .feed(
        "users.live",
        { room: "alpha" },
        {
          meta: { tenantId: "tenant-f" },
          priority: "P1",
          priorityClass: "P2",
          deadlineAtMs: 2500,
          targetLatencyMs: 75,
        },
      )
      [Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStart = parseEnvelope(harness.sent[0]);
    assert.equal(feedStart.op, "feed");
    assert.equal(feedStart.meta?.traceId, "trace-feed");
    assert.equal(feedStart.meta?.tenantId, "tenant-f");
    assert.equal(feedStart.meta?.priority, "P1");
    assert.equal(feedStart.meta?.priorityClass, "P2");
    assert.equal(feedStart.meta?.deadlineAtMs, 2500);
    assert.equal(feedStart.meta?.targetLatencyMs, 75);

    harness.getSocket().emitMessage(
      JSON.stringify({
        id: feedStart.id,
        payload: { feed: "feed-1", exchange: "scomp.live.feed-1" },
      } satisfies ScompTransportResponseEnvelope),
    );

    harness.getSocket().emitMessage(
      JSON.stringify({
        channel: "feed",
        feed: "feed-1",
        type: "next",
        payload: { seq: 1 },
      }),
    );

    const first = await pendingNext;
    assert.equal(first.done, false);
    assert.deepEqual(first.value, { seq: 1 });

    const pendingReturn = iterator.return?.(undefined);
    if (!pendingReturn) throw new Error("Expected feed iterator return()");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStop = parseEnvelope(harness.sent[1]);
    assert.equal(feedStop.op, "signal");
    assert.equal(feedStop.feed, "feed-1");
    assert.equal(feedStop.method, "__scomp.unsubscribe");

    const stopResult = await pendingReturn;
    assert.equal(stopResult.done, true);
  });

  it("delivers queued feed chunks that arrive before feed start response", async () => {
    const harness = createHarness();

    const iterator = harness.transport.feed("users.live", { room: "alpha" })[Symbol.asyncIterator]();

    const pendingFirst = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStart = parseEnvelope(harness.sent[0]);

    // Chunk arrives BEFORE the feed-start response
    harness.getSocket().emitMessage(
      JSON.stringify({
        channel: "feed",
        feed: "feed-race",
        type: "next",
        payload: { seq: 1 },
      }),
    );

    harness.getSocket().emitMessage(
      JSON.stringify({
        id: feedStart.id,
        payload: { feed: "feed-race", exchange: "scomp.live.feed-race" },
      } satisfies ScompTransportResponseEnvelope),
    );

    const first = await pendingFirst;
    assert.equal(first.done, false);
    assert.deepEqual(first.value, { seq: 1 });

    const pendingStop = iterator.return?.(undefined);
    if (!pendingStop) throw new Error("Expected feed iterator return()");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStop = parseEnvelope(harness.sent[1]);
    assert.equal(feedStop.op, "signal");
    assert.equal(feedStop.feed, "feed-race");
    assert.equal(feedStop.method, "__scomp.unsubscribe");

    const stopResult = await pendingStop;
    assert.equal(stopResult.done, true);
  });

  it("propagates disconnect to pending request and active feed", async () => {
    const harness = createHarness();

    const pendingRequest = harness.transport.request("users.get", { id: 1 });
    const iterator = harness.transport.feed("users.live", { room: "alpha" })[Symbol.asyncIterator]();

    const pendingFeedNext = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStart = parseEnvelope(harness.sent[1]);
    harness.getSocket().emitMessage(
      JSON.stringify({
        id: feedStart.id,
        payload: {
          feed: "feed-disconnect",
          exchange: "scomp.live.feed-disconnect",
        },
      } satisfies ScompTransportResponseEnvelope),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.getSocket().emitClose();

    await assert.rejects(pendingRequest, SocketDisconnectedError);
    const feedResult = await pendingFeedNext;
    assert.equal(feedResult.done, true);
  });
});

// ---------------------------------------------------------------------------
// Production hardening tests
// ---------------------------------------------------------------------------

describe("WebSocketClientTransport — hardening", () => {
  // Helper to wait for microtasks/timers to settle
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  // --- Request timeout ---

  it("rejects with RequestTimeoutError when no reply arrives", async () => {
    const harness = createHarness({ requestTimeoutMs: 50 });
    const pending = harness.transport.request("slow.route", {});
    await tick();
    await assert.rejects(pending, RequestTimeoutError);
  });

  it("clears timeout when response arrives in time", async () => {
    const harness = createHarness({ requestTimeoutMs: 200 });
    const pending = harness.transport.request("fast.route", { id: 1 });
    await tick();

    const env = parseEnvelope(harness.sent[0]);
    harness.getSocket().emitMessage(JSON.stringify({ id: env.id, payload: { ok: true } }));

    const result = await pending;
    assert.deepEqual(result, { ok: true });
  });

  // --- Connection timeout ---

  it("rejects with ConnectionTimeoutError when socket never opens", async () => {
    const harness = createHarness({
      connectionTimeoutMs: 50,
      manualOpen: true,
    });
    await assert.rejects(harness.transport.request("any.route", {}), ConnectionTimeoutError);
  });

  // --- In-flight limit ---

  it("throws InFlightLimitError when in-flight limit is reached", async () => {
    const harness = createHarness({ maxInFlightRequests: 2 });

    // Fire two requests (don't resolve them)
    harness.transport.request("r1", {}).catch(() => {});
    harness.transport.request("r2", {}).catch(() => {});
    await tick();

    // Third request should be rejected immediately
    await assert.rejects(harness.transport.request("r3", {}), InFlightLimitError);

    // Close to clean up pending requests
    await harness.transport.close();
  });

  it("allows requests after in-flight count drops below limit", async () => {
    const harness = createHarness({ maxInFlightRequests: 1 });

    const p1 = harness.transport.request("r1", {});
    await tick();

    // Resolve the first request
    const env1 = parseEnvelope(harness.sent[0]);
    harness.getSocket().emitMessage(JSON.stringify({ id: env1.id, payload: { n: 1 } }));
    await p1;

    // Now a second request should succeed
    const p2 = harness.transport.request("r2", {});
    await tick();

    const env2 = parseEnvelope(harness.sent[1]);
    harness.getSocket().emitMessage(JSON.stringify({ id: env2.id, payload: { n: 2 } }));
    assert.deepEqual(await p2, { n: 2 });
  });

  // --- Feed backpressure ---

  it("closes feed when buffer exceeds high-water mark", async () => {
    const harness = createHarness({ feedBufferHighWaterMark: 3 });

    const iterator = harness.transport.feed("live.data", {})[Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    await tick();

    const feedStart = parseEnvelope(harness.sent[0]);
    harness.getSocket().emitMessage(
      JSON.stringify({
        id: feedStart.id,
        payload: { feed: "bp-feed", exchange: "scomp.live.bp-feed" },
      }),
    );

    // Let the generator enter its while loop
    await tick();

    // Emit 4 chunks synchronously (limit is 3, so 4th triggers backpressure)
    for (let i = 0; i < 4; i++) {
      harness.getSocket().emitMessage(
        JSON.stringify({
          channel: "feed",
          feed: "bp-feed",
          type: "next",
          payload: { seq: i },
        }),
      );
    }

    // First chunk should be readable
    const first = await pendingNext;
    assert.deepEqual(first.value, { seq: 0 });

    // Read remaining items — should eventually hit the backpressure error
    const values: unknown[] = [];
    let hitError = false;
    try {
      // Use manual next() calls to drain the queue
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        values.push(result.value);
      }
    } catch (err) {
      hitError = true;
      assert.ok(err instanceof FeedBackpressureError);
    }
    assert.ok(hitError, "Expected FeedBackpressureError");
  });

  // --- Reconnection ---

  it("reconnects with backoff after disconnect", async () => {
    const events: WebSocketTransportEvent[] = [];
    const sent: string[] = [];
    const adapters: FakeSocketAdapter[] = [];
    let callCount = 0;

    const factory: SocketAdapterFactory = () => {
      callCount++;
      const s = new FakeSocketAdapter(sent, false);
      adapters.push(s);
      if (callCount === 1 || callCount === 3) {
        // First and third connections succeed
        queueMicrotask(() => s.emitOpen());
      } else {
        // Second connection fails (reconnect attempt 1 fails)
        queueMicrotask(() => s.emitError(new Error("refused")));
      }
      return s;
    };

    const transport = new WebSocketClientTransport({
      url: "ws://example.test",
      socketAdapter: factory,
      reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
      onEvent: (e) => events.push(e),
    });

    // Initial connection
    const p = transport.request("init", {});
    await tick();

    // Respond to the request
    const env = JSON.parse(sent[0]) as ScompTransportRequestEnvelope;
    adapters[0].emitMessage(JSON.stringify({ id: env.id, payload: { ok: true } }));
    await p;

    // Disconnect — triggers reconnect
    adapters[0].emitClose();

    // Wait for reconnect loop to settle
    await tick(500);

    const reconnectAttempts = events.filter((e) => e.type === "connection_reconnect");
    assert.ok(reconnectAttempts.length >= 1, "Expected at least one reconnect attempt");

    const openedEvents = events.filter((e) => e.type === "connection_opened");
    assert.ok(openedEvents.length >= 1, "Expected reconnect to succeed");

    await transport.close();
  });

  it("emits connection_reconnect_failed when all attempts fail", async () => {
    const events: WebSocketTransportEvent[] = [];
    const sent: string[] = [];
    const adapters: FakeSocketAdapter[] = [];
    let callCount = 0;

    const factory: SocketAdapterFactory = () => {
      callCount++;
      const s = new FakeSocketAdapter(sent, false);
      adapters.push(s);
      if (callCount === 1) {
        queueMicrotask(() => s.emitOpen());
      } else {
        // All reconnect attempts fail
        queueMicrotask(() => s.emitError(new Error("refused")));
      }
      return s;
    };

    const transport = new WebSocketClientTransport({
      url: "ws://example.test",
      socketAdapter: factory,
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
      onEvent: (e) => events.push(e),
    });

    // Initial connection
    const p = transport.request("init", {});
    await tick();

    const env = JSON.parse(sent[0]) as ScompTransportRequestEnvelope;
    adapters[0].emitMessage(JSON.stringify({ id: env.id, payload: { ok: true } }));
    await p;

    // Disconnect
    adapters[0].emitClose();

    // Wait for all reconnect attempts to exhaust
    await tick(500);

    const failEvent = events.find((e) => e.type === "connection_reconnect_failed");
    assert.ok(failEvent, "Expected connection_reconnect_failed event");
    if (failEvent?.type === "connection_reconnect_failed") {
      assert.equal(failEvent.attempts, 2);
    }

    await transport.close();
  });

  it("close() cancels active reconnect loop", async () => {
    const events: WebSocketTransportEvent[] = [];
    let callCount = 0;
    const sent: string[] = [];
    const adapters: FakeSocketAdapter[] = [];

    const factory: SocketAdapterFactory = () => {
      callCount++;
      const s = new FakeSocketAdapter(sent, false);
      adapters.push(s);
      if (callCount === 1) {
        queueMicrotask(() => s.emitOpen());
      } else {
        // Reconnect attempts: never open (hang forever)
        // Don't emit anything — simulates slow reconnect
      }
      return s;
    };

    const transport = new WebSocketClientTransport({
      url: "ws://example.test",
      socketAdapter: factory,
      connectionTimeoutMs: 50,
      reconnect: { enabled: true, maxAttempts: 10, baseDelayMs: 50, maxDelayMs: 200 },
      onEvent: (e) => events.push(e),
    });

    // Initial connect
    const p = transport.request("init", {});
    await tick();

    // Respond to the pending request
    const env = JSON.parse(sent[0]) as ScompTransportRequestEnvelope;
    adapters[0].emitMessage(JSON.stringify({ id: env.id, payload: { ok: true } }));
    await p;

    // Disconnect — triggers reconnect loop
    adapters[0].emitClose();
    await tick(100);

    // Close should abort the reconnect
    await transport.close();

    const reconnectAttempts = events.filter((e) => e.type === "connection_reconnect").length;
    // Should have started but not completed all 10 attempts
    assert.ok(reconnectAttempts < 10, `Expected < 10 reconnect attempts, got ${reconnectAttempts}`);
  });

  // --- onEvent callback ---

  it("emits request_timeout event via onEvent", async () => {
    const events: WebSocketTransportEvent[] = [];
    const harness = createHarness({
      requestTimeoutMs: 50,
      onEvent: (e) => events.push(e),
    });

    await harness.transport.request("timeout.route", {}).catch(() => {});
    await tick(100);

    const timeoutEvent = events.find((e) => e.type === "request_timeout");
    assert.ok(timeoutEvent, "Expected request_timeout event");
    assert.equal(timeoutEvent?.type, "request_timeout");
    if (timeoutEvent?.type === "request_timeout") {
      assert.equal(timeoutEvent.route, "timeout.route");
      assert.equal(timeoutEvent.timeoutMs, 50);
    }
  });

  it("emits in_flight_limit event via onEvent", async () => {
    const events: WebSocketTransportEvent[] = [];
    const harness = createHarness({
      maxInFlightRequests: 1,
      onEvent: (e) => events.push(e),
    });

    harness.transport.request("r1", {}).catch(() => {});
    await tick();

    await harness.transport.request("r2", {}).catch(() => {});

    const limitEvent = events.find((e) => e.type === "in_flight_limit");
    assert.ok(limitEvent, "Expected in_flight_limit event");
    if (limitEvent?.type === "in_flight_limit") {
      assert.equal(limitEvent.route, "r2");
      assert.equal(limitEvent.limit, 1);
    }

    await harness.transport.close();
  });
});
