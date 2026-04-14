import assert from "node:assert/strict";
import type {
  ScompTransportSecurityPolicy,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scomp/types";
import {
  SocketDisconnectedError,
  WebSocketClientTransport,
  type ISocketAdapter,
  type SocketAdapterFactory,
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

  constructor(sent: Array<string>) {
    this.sent = sent;
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      for (const h of this.openHandlers) h();
    });
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
}

function createHarness(options?: {
  meta?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  security?: ScompTransportSecurityPolicy;
}): Harness {
  const sent: Array<string> = [];
  let socket: FakeSocketAdapter | undefined;

  const socketAdapter: SocketAdapterFactory = (_url, _protocols) => {
    socket = new FakeSocketAdapter(sent);
    return socket;
  };

  const transport = new WebSocketClientTransport({
    url: "ws://example.test",
    meta: options?.meta,
    security: options?.security,
    socketAdapter,
  });

  return {
    transport,
    sent,
    getSocket: () => {
      if (!socket) throw new Error("Expected socket to initialize");
      return socket;
    },
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

  it("executes authenticate and authorize hooks", async () => {
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

    const requestPending = harness.transport.request(
      "users.get",
      { id: 1 },
      {
        meta: {
          tenantId: "tenant-invoke",
          auth: { source: "invoke" },
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestEnvelope = parseEnvelope(harness.sent[0]);
    harness.getSocket().emitMessage(
      JSON.stringify({
        id: requestEnvelope.id,
        payload: { ok: true },
      } satisfies ScompTransportResponseEnvelope),
    );
    await requestPending;

    await harness.transport.signal(
      "users.notify",
      { id: 2 },
      { meta: { tenantId: "tenant-signal" } },
    );

    const iterator = harness.transport
      .feed(
        "users.live",
        { room: "alpha" },
        { meta: { tenantId: "tenant-feed" } },
      )
      [Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const feedStartEnvelope = parseEnvelope(harness.sent[2]);
    harness.getSocket().emitMessage(
      JSON.stringify({
        id: feedStartEnvelope.id,
        payload: {
          feed: "feed-security",
          exchange: "scomp.live.feed-security",
        },
      } satisfies ScompTransportResponseEnvelope),
    );
    harness.getSocket().emitMessage(
      JSON.stringify({
        channel: "feed",
        feed: "feed-security",
        type: "next",
        payload: { seq: 1 },
      }),
    );
    await pendingNext;

    const pendingReturn = iterator.return?.(undefined);
    if (!pendingReturn) throw new Error("Expected feed iterator return()");

    await new Promise((resolve) => setTimeout(resolve, 0));
    await pendingReturn;

    assert.deepEqual(observedOps, ["request", "signal", "feed"]);
    assert.deepEqual(observedSubjects, [
      "subject:request",
      "subject:signal",
      "subject:feed",
    ]);

    assert.equal(requestEnvelope.meta?.tenantId, "tenant-principal");
    assert.equal(
      (requestEnvelope.meta?.auth as { subject?: string } | undefined)
        ?.subject,
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

  it("delivers queued feed chunks that arrive before feed start response", async () => {
    const harness = createHarness();

    const iterator = harness.transport
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();

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
    const iterator = harness.transport
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();

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
