import { BrowserWindowsSharedWorkerBroker } from "../src/shared-worker-broker";
import { BrowserWindowsTransport } from "../src/transport-browser-windows";
import { FakeBroadcastChannel } from "./test-doubles/fake-broadcast-channel";
import {
  createFakeSharedWorkerCtor,
  FakeSilentSharedWorker,
} from "./test-doubles/fake-shared-worker";

let mockWorkerBroker: BrowserWindowsSharedWorkerBroker;

function sharedWorkerCtor() {
  return createFakeSharedWorkerCtor((port) => {
    mockWorkerBroker.attachPort(port);
  });
}

const MockSharedWorker = sharedWorkerCtor();
const SilentSharedWorker = FakeSilentSharedWorker;
const MockBroadcastChannel = FakeBroadcastChannel;

class MissingBroadcastChannel {
  constructor(_name: string) {
    throw new Error("BroadcastChannel unavailable in test runtime.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestReasonCode(transport: BrowserWindowsTransport): string | undefined {
  const snapshot = transport.healthSnapshot();
  const last = snapshot.reasons[snapshot.reasons.length - 1];
  return last?.code;
}

function hasReasonCode(transport: BrowserWindowsTransport, code: string): boolean {
  return transport.healthSnapshot().reasons.some((reason) => reason.code === code);
}

describe("BrowserWindowsTransport shared worker", () => {
  beforeEach(() => {
    mockWorkerBroker = new BrowserWindowsSharedWorkerBroker();
    FakeBroadcastChannel.reset();
  });

  test("request round-trip resolves response payload", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    host.listen({
      "svc.double": {
        route: "svc.double",
        kind: "request",
        handler(payload: unknown) {
          return { value: Number((payload as { value: number }).value) * 2 };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    const response = await invoke.request("svc.double", { value: 7 });
    expect(response).toEqual({ value: 14 });

    invoke.close();
    host.close();
  });

  test("request timeout rejects and frees pending slot", async () => {
    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: SilentSharedWorker as any,
      requestTimeoutMs: 15,
      maxPendingRequests: 1,
    });

    await expect(invoke.request("svc.never", { id: 1 })).rejects.toThrow(
      /request timed out/i,
    );
    expect(latestReasonCode(invoke)).toBe("request-timeout");

    await expect(invoke.request("svc.never", { id: 2 })).rejects.toThrow(
      /request timed out/i,
    );

    invoke.close();
  });

  test("max pending requests guard rejects overflow", async () => {
    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: SilentSharedWorker as any,
      requestTimeoutMs: 500,
      maxPendingRequests: 1,
    });

    const first = invoke.request("svc.never", { id: 1 });
    await expect(invoke.request("svc.never", { id: 2 })).rejects.toThrow(
      /max pending requests exceeded/i,
    );

    await expect(first).rejects.toThrow(/request timed out/i);
    invoke.close();
  });

  test("signal fanout reaches all registered hosts", async () => {
    const calls: Array<string> = [];

    const hostA = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    hostA.listen({
      "svc.ping": {
        route: "svc.ping",
        kind: "signal",
        async handler(payload: unknown) {
          calls.push(`a:${String((payload as { value: string }).value)}`);
        },
      },
    });

    const hostB = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    hostB.listen({
      "svc.ping": {
        route: "svc.ping",
        kind: "signal",
        async handler(payload: unknown) {
          calls.push(`b:${String((payload as { value: string }).value)}`);
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    await invoke.signal("svc.ping", { value: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(expect.arrayContaining(["a:ok", "b:ok"]));
    expect(calls).toHaveLength(2);

    invoke.close();
    hostA.close();
    hostB.close();
  });

  test("feed start/chunk/stop lifecycle streams values", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.stream": {
        route: "svc.stream",
        kind: "feed",
        handler() {
          return {
            async *[Symbol.asyncIterator]() {
              yield 1;
              yield 2;
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    const values: Array<number> = [];
    for await (const chunk of invoke.feed("svc.stream", { from: "test" })) {
      values.push(chunk as number);
    }

    expect(values).toEqual([1, 2]);

    invoke.close();
    host.close();
  });

  test("feed subscriber buffer high-water triggers deterministic termination", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.hot": {
        route: "svc.hot",
        kind: "feed",
        handler() {
          return {
            async *[Symbol.asyncIterator]() {
              for (let i = 0; i < 10; i += 1) {
                yield i;
              }
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      maxBufferedFeedChunksPerSubscriber: 2,
    });

    const iterator = invoke.feed("svc.hot", { id: 1 })[Symbol.asyncIterator]();
    await iterator.next();
    await sleep(20);
    await expect(iterator.next()).rejects.toThrow(/feed buffer exceeded/i);

    invoke.close();
    host.close();
  });

  test("disconnect cleanup rejects pending request and terminates feed", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.hang": {
        route: "svc.hang",
        kind: "request",
        async handler() {
          return await new Promise(() => {
            // intentional never-resolve
          });
        },
      },
      "svc.live": {
        route: "svc.live",
        kind: "feed",
        handler() {
          let stopped = false;
          return {
            unsubscribe() {
              stopped = true;
            },
            async *[Symbol.asyncIterator]() {
              let n = 0;
              while (!stopped) {
                await sleep(3);
                yield n;
                n += 1;
              }
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      requestTimeoutMs: 1_000,
    });

    const pendingRequest = invoke.request("svc.hang", { id: 1 });
    const feedIterator = invoke.feed("svc.live", { id: 1 })[Symbol.asyncIterator]();
    await feedIterator.next();

    host.close();

    await expect(pendingRequest).rejects.toThrow(/host disconnected/i);
    expect(latestReasonCode(invoke)).toBe("host-disconnected");
    await expect(feedIterator.next()).rejects.toThrow(/feed host disconnected/i);

    invoke.close();
  });

  test("feed multiplexes subscribers and stops upstream once", async () => {
    let feedStarts = 0;
    let feedStops = 0;
    let stopped = false;

    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.mux": {
        route: "svc.mux",
        kind: "feed",
        handler() {
          feedStarts += 1;
          let index = 0;
          return {
            unsubscribe() {
              stopped = true;
              feedStops += 1;
            },
            async *[Symbol.asyncIterator]() {
              await sleep(15);
              while (!stopped) {
                await sleep(2);
                yield index;
                index += 1;
              }
            },
          };
        },
      },
    });

    const invokeA = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    const invokeB = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    const iteratorA = invokeA.feed("svc.mux", { key: "same" })[Symbol.asyncIterator]();
    const iteratorB = invokeB.feed("svc.mux", { key: "same" })[Symbol.asyncIterator]();

    const [firstA, firstB] = await Promise.all([iteratorA.next(), iteratorB.next()]);
    expect(firstA.value).toBe(0);
    expect(firstB.value).toBe(0);
    expect(feedStarts).toBe(1);

    await iteratorA.return?.(undefined);
    await sleep(10);
    expect(feedStops).toBe(0);

    await iteratorB.return?.(undefined);
    await sleep(10);
    expect(feedStops).toBe(1);

    invokeA.close();
    invokeB.close();
    host.close();
  });

  test("broadcast fallback activates when SharedWorker is unavailable", async () => {
    const snapshots: Array<string> = [];
    const host = new BrowserWindowsTransport({
      nodeId: "node-host",
      channelName: "test-fallback-sharedworker-missing",
      sharedWorkerCtor: undefined,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
      health: {
        onSnapshot(snapshot) {
          snapshots.push(snapshot.status);
        },
      },
    });

    host.listen({
      "svc.double": {
        route: "svc.double",
        kind: "request",
        handler(payload: unknown) {
          return { value: Number((payload as { value: number }).value) * 2 };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      nodeId: "node-invoke",
      channelName: "test-fallback-sharedworker-missing",
      sharedWorkerCtor: undefined,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hasReasonCode(host, "shared-worker-unavailable")).toBe(true);
    expect(snapshots).toContain("degraded");
    const response = await invoke.request("svc.double", { value: 9 });
    expect(response).toEqual({ value: 18 });

    invoke.close();
    host.close();
  });

  test("mode=broadcast-channel reports broadcast-channel-unavailable before throw", () => {
    const snapshots: Array<{ status: string; codes: Array<string> }> = [];

    expect(
      () =>
        new BrowserWindowsTransport({
          mode: "broadcast-channel",
          broadcastChannelCtor: MissingBroadcastChannel as any,
          health: {
            onSnapshot(snapshot) {
              snapshots.push({
                status: snapshot.status,
                codes: snapshot.reasons.map((reason) => reason.code),
              });
            },
          },
        }),
    ).toThrow(/broadcast-channel-unavailable/i);

    expect(snapshots.length).toBeGreaterThan(0);
    const latest = snapshots[snapshots.length - 1];
    expect(latest?.status).toBe("unavailable");
    expect(latest?.codes).toContain("broadcast-channel-unavailable");
  });

  test("shared-worker fallback failure reports broadcast-channel-unavailable before throw", () => {
    const snapshots: Array<{ status: string; codes: Array<string> }> = [];

    expect(
      () =>
        new BrowserWindowsTransport({
          mode: "auto",
          sharedWorkerCtor: undefined,
          broadcastChannelCtor: MissingBroadcastChannel as any,
          health: {
            onSnapshot(snapshot) {
              snapshots.push({
                status: snapshot.status,
                codes: snapshot.reasons.map((reason) => reason.code),
              });
            },
          },
        }),
    ).toThrow(/broadcast-channel-unavailable/i);

    expect(snapshots.length).toBeGreaterThan(0);
    const latest = snapshots[snapshots.length - 1];
    expect(latest?.status).toBe("unavailable");
    expect(latest?.codes).toContain("broadcast-channel-unavailable");
  });

  test("broadcast mode failover recovers subsequent requests", async () => {
    const channelName = "test-broadcast-failover";

    const firstLeader = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-a",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    const host = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-b",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    host.listen({
      "svc.identity": {
        route: "svc.identity",
        kind: "request",
        handler(payload: unknown) {
          return payload;
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-c",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeFailover = await invoke.request("svc.identity", { value: "before" });
    expect(beforeFailover).toEqual({ value: "before" });

    firstLeader.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const afterFailover = await invoke.request("svc.identity", { value: "after" });
    expect(afterFailover).toEqual({ value: "after" });

    invoke.close();
    host.close();
  });

  test("broadcast mode multiplexes same feed hash across subscribers", async () => {
    const channelName = "test-broadcast-feed-multiplex";
    let feedStarts = 0;
    let feedStops = 0;
    let stopped = false;

    const host = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-host",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    host.listen({
      "svc.mux": {
        route: "svc.mux",
        kind: "feed",
        handler() {
          feedStarts += 1;
          let index = 0;
          return {
            unsubscribe() {
              stopped = true;
              feedStops += 1;
            },
            async *[Symbol.asyncIterator]() {
              await sleep(15);
              while (!stopped) {
                await sleep(2);
                yield index;
                index += 1;
              }
            },
          };
        },
      },
    });

    const invokeA = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-a",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });
    const invokeB = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-b",
      channelName,
      broadcastChannelCtor: MockBroadcastChannel as any,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 40,
    });

    await sleep(50);

    const iteratorA = invokeA.feed("svc.mux", { key: "same" })[Symbol.asyncIterator]();
    const iteratorB = invokeB.feed("svc.mux", { key: "same" })[Symbol.asyncIterator]();

    const [firstA, firstB] = await Promise.all([iteratorA.next(), iteratorB.next()]);
    expect(firstA.value).toBe(0);
    expect(firstB.value).toBe(0);
    expect(feedStarts).toBe(1);

    await iteratorA.return?.(undefined);
    await sleep(10);
    expect(feedStops).toBe(0);

    await iteratorB.return?.(undefined);
    await sleep(10);
    expect(feedStops).toBe(1);

    invokeA.close();
    invokeB.close();
    host.close();
  });

  test("applies deterministic metadata precedence with principal auth last", async () => {
    let observedMeta: Record<string, unknown> | undefined;

    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      security: {
        authorize: ({ operation, meta }) => {
          if (operation === "request") {
            observedMeta = meta as Record<string, unknown> | undefined;
          }
          return true;
        },
      },
    });

    host.listen({
      "svc.meta": {
        route: "svc.meta",
        kind: "request",
        handler() {
          return { ok: true };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      meta: {
        traceId: "cfg-trace",
        tenantId: "cfg-tenant",
        tags: { source: "config" },
      },
      security: {
        authenticate: () => ({
          subject: "subject:request",
          tenantId: "tenant-principal",
          claims: { via: "authn" },
        }),
        authorize: () => true,
      },
    });

    const result = await invoke.request("svc.meta", { id: 1 }, {
      meta: {
        tenantId: "tenant-options",
        auth: { source: "options" },
      },
      priority: "P0",
      priorityClass: "P1",
      deadlineAtMs: 200,
      targetLatencyMs: 10,
    });

    expect(result).toEqual({ ok: true });
    expect(observedMeta?.traceId).toBe("cfg-trace");
    expect(observedMeta?.tenantId).toBe("tenant-principal");
    expect(observedMeta?.priority).toBe("P0");
    expect(observedMeta?.priorityClass).toBe("P1");
    expect(observedMeta?.deadlineAtMs).toBe(200);
    expect(observedMeta?.targetLatencyMs).toBe(10);
    expect(observedMeta?.tags).toEqual({ source: "config" });
    expect(observedMeta?.auth).toEqual({
      subject: "subject:request",
      tenantId: "tenant-principal",
      scopes: undefined,
      claims: { via: "authn" },
      issuedAt: undefined,
      expiresAt: undefined,
      authType: undefined,
    });

    invoke.close();
    host.close();
  });

  test("preserves inbound security meta parity for feed_start/feed_stop", async () => {
    const seenByOperation = new Map<string, Array<Record<string, unknown> | undefined>>();

    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      security: {
        authorize: ({ operation, meta }) => {
          const list = seenByOperation.get(operation) ?? [];
          list.push(meta as Record<string, unknown> | undefined);
          seenByOperation.set(operation, list);
          return true;
        },
      },
    });

    host.listen({
      "svc.secure-feed": {
        route: "svc.secure-feed",
        kind: "feed",
        handler() {
          let stopped = false;
          return {
            unsubscribe() {
              stopped = true;
            },
            async *[Symbol.asyncIterator]() {
              let n = 0;
              while (!stopped && n < 3) {
                await sleep(2);
                yield n;
                n += 1;
              }
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      meta: {
        traceId: "trace-feed-meta",
        tenantId: "tenant-feed-meta",
      },
      security: {
        authorize: () => true,
      },
    });

    const iterator = invoke.feed("svc.secure-feed", { id: 1 })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    await sleep(15);

    const startMeta = seenByOperation.get("feed_start")?.[0];
    const stopMeta = seenByOperation.get("feed_stop")?.[0];
    expect(startMeta?.traceId).toBe("trace-feed-meta");
    expect(startMeta?.tenantId).toBe("tenant-feed-meta");
    expect(stopMeta?.traceId).toBe("trace-feed-meta");
    expect(stopMeta?.tenantId).toBe("tenant-feed-meta");

    invoke.close();
    host.close();
  });

  test("denies request/signal/feed operations with clear authorization errors", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    host.listen({
      "svc.secure": {
        route: "svc.secure",
        kind: "request",
        handler() {
          return { ok: true };
        },
      },
      "svc.signal": {
        route: "svc.signal",
        kind: "signal",
        async handler() {
          return;
        },
      },
      "svc.feed": {
        route: "svc.feed",
        kind: "feed",
        handler() {
          return {
            async *[Symbol.asyncIterator]() {
              yield 1;
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
      security: {
        authorize: () => false,
      },
    });

    await expect(invoke.request("svc.secure", { id: 1 })).rejects.toThrow(
      /request not authorized/i,
    );
    expect(latestReasonCode(invoke)).toBe("auth-denied");
    await expect(invoke.signal("svc.signal", { id: 1 })).rejects.toThrow(
      /signal not authorized/i,
    );

    const iterator = invoke.feed("svc.feed", { id: 1 })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/feed_start not authorized/i);

    invoke.close();
    host.close();
  });

  test("works normally when no security policy is configured", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.open": {
        route: "svc.open",
        kind: "request",
        handler(payload: unknown) {
          return payload;
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    await expect(invoke.request("svc.open", { ok: true })).resolves.toEqual({
      ok: true,
    });

    invoke.close();
    host.close();
  });

  test("subscribeHealth emits immediate initial snapshot", async () => {
    const transport = new BrowserWindowsTransport({
      sharedWorkerCtor: SilentSharedWorker as any,
    });

    const snapshots: Array<string> = [];
    const unsubscribe = transport.subscribeHealth((snapshot) => {
      snapshots.push(snapshot.status);
    });

    expect(snapshots[0]).toBe("healthy");
    unsubscribe();
    transport.close();
  });
});
