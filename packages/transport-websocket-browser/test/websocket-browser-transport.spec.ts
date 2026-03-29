import assert from "node:assert/strict";
import {
  type ScompTransportSecurityPolicy,
  type ScompTransportRequestEnvelope,
  type ScompTransportResponseEnvelope,
} from "@scomp/types";
import { WebSocketBrowserTransport } from "../src";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  public readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  private readonly sent: Array<string>;

  constructor(
    private readonly _url: string,
    _protocols: string | Array<string> | undefined,
    sent: Array<string>,
  ) {
    this.sent = sent;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const queue = this.listeners.get(type) ?? [];
    queue.push(listener);
    this.listeners.set(type, queue);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const queue = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      queue.filter((entry) => entry !== listener),
    );
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: any): void {
    const queue = this.listeners.get(type) ?? [];
    for (const listener of queue) {
      listener(event);
    }
  }
}

interface BrowserHarness {
  transport: WebSocketBrowserTransport;
  sent: Array<string>;
  getSocket: () => FakeWebSocket;
}

function createHarness(options?: {
  meta?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  security?: ScompTransportSecurityPolicy;
}): BrowserHarness {
  const sent: Array<string> = [];
  let socket: FakeWebSocket | undefined;

  const webSocketCtor = class {
    constructor(url: string, protocols?: string | Array<string>) {
      socket = new FakeWebSocket(url, protocols, sent);
      return socket;
    }
  } as unknown as new (
    url: string,
    protocols?: string | Array<string>,
  ) => WebSocket;

  const transport = new WebSocketBrowserTransport({
    url: "ws://example.test",
    meta: options?.meta,
    security: options?.security,
    webSocketCtor,
  });

  return {
    transport,
    sent,
    getSocket: () => {
      if (!socket) {
        throw new Error("Expected socket to initialize");
      }

      return socket;
    },
  };
}

function parseEnvelope(payload: string): ScompTransportRequestEnvelope {
  return JSON.parse(payload) as ScompTransportRequestEnvelope;
}

function parseResponse(payload: string): ScompTransportResponseEnvelope {
  return JSON.parse(payload) as ScompTransportResponseEnvelope;
}

describe("WebSocketBrowserTransport invocation parity", () => {
  it("includes invocation options in request envelope metadata", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-request",
        tags: { source: "browser" },
      },
    });

    const pending = harness.transport.request("users.get", { id: 1 }, {
      meta: { tenantId: "tenant-a" },
      priority: "P0",
      priorityClass: "P1",
      deadlineAtMs: 500,
      targetLatencyMs: 20,
    });

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

    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: outbound.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    });

    assert.deepEqual(await pending, { ok: true });
  });

  it("includes invocation options in signal envelopes", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-signal",
      },
    });

    await harness.transport.signal("users.notify", { id: 2 }, {
      meta: { tenantId: "tenant-s" },
      priority: "P2",
      priorityClass: "P3",
      deadlineAtMs: 1000,
      targetLatencyMs: 50,
    });

    const outbound = parseEnvelope(harness.sent[0]);
    assert.equal(outbound.op, "signal");
    assert.equal(outbound.meta?.traceId, "trace-signal");
    assert.equal(outbound.meta?.tenantId, "tenant-s");
    assert.equal(outbound.meta?.priority, "P2");
    assert.equal(outbound.meta?.priorityClass, "P3");
    assert.equal(outbound.meta?.deadlineAtMs, 1000);
    assert.equal(outbound.meta?.targetLatencyMs, 50);
  });

  it("uses identical metadata for feed_start and feed_stop", async () => {
    const harness = createHarness({
      meta: {
        traceId: "trace-feed",
      },
    });

    const iterator = harness.transport
      .feed("users.live", { room: "alpha" }, {
        meta: { tenantId: "tenant-f" },
        priority: "P1",
        priorityClass: "P2",
        deadlineAtMs: 2500,
        targetLatencyMs: 75,
      })
      [Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStart = parseEnvelope(harness.sent[0]);
    assert.equal(feedStart.op, "feed_start");
    assert.equal(feedStart.meta?.traceId, "trace-feed");
    assert.equal(feedStart.meta?.tenantId, "tenant-f");
    assert.equal(feedStart.meta?.priority, "P1");
    assert.equal(feedStart.meta?.priorityClass, "P2");
    assert.equal(feedStart.meta?.deadlineAtMs, 2500);
    assert.equal(feedStart.meta?.targetLatencyMs, 75);

    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: feedStart.id,
        payload: { hash: "feed-1", exchange: "scomp.live.feed-1" },
      } satisfies ScompTransportResponseEnvelope),
    });

    harness.getSocket().emit("message", {
      data: JSON.stringify({
        channel: "feed",
        hash: "feed-1",
        type: "next",
        payload: { seq: 1 },
      }),
    });

    const first = await pendingNext;
    assert.equal(first.done, false);
    assert.deepEqual(first.value, { seq: 1 });

    const pendingReturn = iterator.return?.(undefined);
    if (!pendingReturn) {
      throw new Error("Expected feed iterator return()");
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStop = parseEnvelope(harness.sent[1]);
    assert.equal(feedStop.op, "feed_stop");
    assert.deepEqual(feedStop.payload, { hash: "feed-1" });
    assert.deepEqual(feedStop.meta, feedStart.meta);

    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: feedStop.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    });

    const stopResult = await pendingReturn;
    assert.equal(stopResult.done, true);
  });

  it("executes authenticate and authorize hooks for request/signal/feed operations", async () => {
    const observedOps: Array<string> = [];
    const observedSubjects: Array<string | undefined> = [];

    const harness = createHarness({
      meta: { traceId: "trace-security" },
      security: {
        authenticate: ({ operation }) => ({
          subject: `subject:${operation}`,
          tenantId: "tenant-principal",
          claims: { via: "authn" },
        }),
        authorize: (ctx) => {
          observedOps.push(ctx.operation);
          observedSubjects.push(ctx.principal?.subject);
          return true;
        },
      },
    });

    const requestPending = harness.transport.request("users.get", { id: 1 }, {
      meta: {
        tenantId: "tenant-invoke",
        auth: { source: "invoke" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestEnvelope = parseEnvelope(harness.sent[0]);
    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: requestEnvelope.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    });
    await requestPending;

    await harness.transport.signal("users.notify", { id: 2 }, {
      meta: { tenantId: "tenant-signal" },
    });

    const iterator = harness.transport
      .feed("users.live", { room: "alpha" }, {
        meta: { tenantId: "tenant-feed" },
      })
      [Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStartEnvelope = parseEnvelope(harness.sent[2]);
    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: feedStartEnvelope.id,
        payload: { hash: "feed-security", exchange: "scomp.live.feed-security" },
      } satisfies ScompTransportResponseEnvelope),
    });
    harness.getSocket().emit("message", {
      data: JSON.stringify({
        channel: "feed",
        hash: "feed-security",
        type: "next",
        payload: { seq: 1 },
      }),
    });
    await pendingNext;

    const pendingReturn = iterator.return?.(undefined);
    if (!pendingReturn) {
      throw new Error("Expected feed iterator return()");
    }

    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStopEnvelope = parseEnvelope(harness.sent[3]);
    harness.getSocket().emit("message", {
      data: JSON.stringify({
        id: feedStopEnvelope.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    });

    await pendingReturn;

    assert.deepEqual(observedOps, [
      "request",
      "signal",
      "feed_start",
      "feed_stop",
    ]);
    assert.deepEqual(observedSubjects, [
      "subject:request",
      "subject:signal",
      "subject:feed_start",
      "subject:feed_stop",
    ]);

    assert.equal(requestEnvelope.meta?.tenantId, "tenant-principal");
    assert.equal(
      (requestEnvelope.meta?.auth as { subject?: string } | undefined)?.subject,
      "subject:request",
    );
  });

  it("fails denied operations before sending envelopes", async () => {
    const harness = createHarness({
      security: {
        authorize: ({ operation }) => operation !== "signal",
      },
    });

    await assert.rejects(
      () => harness.transport.signal("users.notify", { id: 9 }),
      /not authorized/i,
    );

    assert.equal(harness.sent.length, 0);
  });
});
