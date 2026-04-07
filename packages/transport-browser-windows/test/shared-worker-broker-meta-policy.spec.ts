import {
  cleanupDisconnectedParticipant,
} from "../src/shared-worker-broker-disconnect";
import {
  handleHostFeedChunk,
  handleInvokeFeedStop,
} from "../src/shared-worker-broker-dispatch";
import {
  BROKER_REASON_META_TAG,
  BROKER_SYSTEM_META_TAG,
} from "../src/shared-worker-broker-meta";
import {
  createBrokerState,
  createFeedKey,
  type BrokerContext,
} from "../src/shared-worker-broker-context";
import type { BrowserWindowsProtocolMessage } from "../src/protocol";

function createTestContext() {
  const sent: Array<{
    participantId: string;
    message: BrowserWindowsProtocolMessage;
  }> = [];

  const context: BrokerContext = {
    state: createBrokerState(),
    portsByParticipant: new Map(),
    routesByParticipant: new Map(),
    sendToParticipant(participantId, message) {
      sent.push({ participantId, message });
    },
    sendTo() {
      return;
    },
  };

  return { context, sent };
}

describe("shared-worker broker meta policy", () => {
  test("normal invoke feed_stop forwards caller feed_stop meta", () => {
    const { context, sent } = createTestContext();
    const sourceMeta = { traceId: "meta-source", tenantId: "tenant-a" };
    const stopMeta = { traceId: "meta-stop" };
    const key = createFeedKey("svc.feed", '{"id":1}', "hash-1");

    context.state.feedSubscriptions.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":1}',
      payloadHash: "hash-1",
      subscribersByRequestId: new Map([["req-source", "invoke-a"]]),
      metaByRequestId: new Map([["req-source", sourceMeta]]),
    });
    context.state.activeUpstreamFeeds.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":1}',
      payloadHash: "hash-1",
      ownerHostId: "host-a",
      sourceRequestId: "req-source",
      startedAtMs: 0,
    });
    context.state.pendingRequests.set("req-source", {
      requestId: "req-source",
      invokeId: "invoke-a",
      hostId: "host-a",
      route: "svc.feed",
      createdAtMs: Date.now(),
      meta: sourceMeta,
    });

    handleInvokeFeedStop(context, {
      type: "invoke_feed_stop",
      sourceId: "invoke-a",
      sentAtMs: Date.now(),
      requestId: "req-source",
      route: "svc.feed",
      operation: "feed_stop",
      payloadKey: '{"id":1}',
      payloadHash: "hash-1",
      meta: stopMeta,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.type).toBe("host_feed_stop");
    expect(sent[0]?.message.meta).toEqual(stopMeta);
  });

  test("cleanup disconnect host_feed_stop carries source meta with broker-system tags", () => {
    const { context, sent } = createTestContext();
    const sourceMeta = { traceId: "feed-trace", tenantId: "tenant-feed" };
    const key = createFeedKey("svc.feed", '{"id":1}', "hash-1");

    context.state.feedSubscriptions.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":1}',
      payloadHash: "hash-1",
      subscribersByRequestId: new Map([["req-source", "invoke-a"]]),
      metaByRequestId: new Map([["req-source", sourceMeta]]),
    });
    context.state.activeUpstreamFeeds.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":1}',
      payloadHash: "hash-1",
      ownerHostId: "host-a",
      sourceRequestId: "req-source",
      startedAtMs: 0,
    });
    context.state.pendingRequests.set("req-source", {
      requestId: "req-source",
      invokeId: "invoke-a",
      hostId: "host-a",
      route: "svc.feed",
      createdAtMs: Date.now(),
      meta: sourceMeta,
    });

    cleanupDisconnectedParticipant(context, "invoke-a");

    expect(sent).toHaveLength(1);
    const message = sent[0]?.message;
    expect(message?.type).toBe("host_feed_stop");
    expect(message?.meta).toMatchObject({
      traceId: "feed-trace",
      tenantId: "tenant-feed",
      tags: {
        [BROKER_SYSTEM_META_TAG]: "true",
        [BROKER_REASON_META_TAG]: "disconnect-cleanup-feed-stop",
      },
    });
  });

  test("host disconnect response/feed errors preserve invoke meta plus broker tags", () => {
    const { context, sent } = createTestContext();
    const requestMeta = { traceId: "req-meta", tenantId: "tenant-request" };
    const feedMeta = { traceId: "feed-meta", tenantId: "tenant-feed" };
    const key = createFeedKey("svc.feed", '{"id":2}', "hash-2");

    context.state.feedSubscriptions.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":2}',
      payloadHash: "hash-2",
      subscribersByRequestId: new Map([["req-feed", "invoke-feed"]]),
      metaByRequestId: new Map([["req-feed", feedMeta]]),
    });
    context.state.activeUpstreamFeeds.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":2}',
      payloadHash: "hash-2",
      ownerHostId: "host-a",
      sourceRequestId: "req-feed-source",
      startedAtMs: Date.now(),
    });
    context.state.pendingRequests.set("req-feed", {
      requestId: "req-feed",
      invokeId: "invoke-feed",
      hostId: "host-a",
      route: "svc.feed",
      createdAtMs: Date.now(),
      meta: feedMeta,
    });
    context.state.pendingRequests.set("req-request", {
      requestId: "req-request",
      invokeId: "invoke-request",
      hostId: "host-a",
      route: "svc.request",
      createdAtMs: Date.now(),
      meta: requestMeta,
    });

    cleanupDisconnectedParticipant(context, "host-a");

    const feedError = sent.find((entry) => entry.message.type === "invoke_feed_chunk")?.message;
    expect(feedError?.type).toBe("invoke_feed_chunk");
    expect(feedError?.meta).toMatchObject({
      traceId: "feed-meta",
      tenantId: "tenant-feed",
      tags: {
        [BROKER_SYSTEM_META_TAG]: "true",
        [BROKER_REASON_META_TAG]: "disconnect-cleanup-feed-error",
      },
    });

    const responseError = sent.find((entry) => entry.message.type === "invoke_response")?.message;
    expect(responseError?.type).toBe("invoke_response");
    expect(responseError?.meta).toMatchObject({
      traceId: "req-meta",
      tenantId: "tenant-request",
      tags: {
        [BROKER_SYSTEM_META_TAG]: "true",
        [BROKER_REASON_META_TAG]: "disconnect-host-response-error",
      },
    });
  });

  test("host feed chunk fanout uses subscriber meta parity", () => {
    const { context, sent } = createTestContext();
    const key = createFeedKey("svc.feed", '{"id":3}', "hash-3");

    context.state.feedSubscriptions.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":3}',
      payloadHash: "hash-3",
      subscribersByRequestId: new Map([
        ["req-a", "invoke-a"],
        ["req-b", "invoke-b"],
      ]),
      metaByRequestId: new Map([
        ["req-a", { traceId: "trace-a" }],
        ["req-b", { traceId: "trace-b" }],
      ]),
    });
    context.state.activeUpstreamFeeds.set(key, {
      route: "svc.feed",
      payloadKey: '{"id":3}',
      payloadHash: "hash-3",
      ownerHostId: "host-a",
      sourceRequestId: "req-a",
      startedAtMs: Date.now(),
    });

    handleHostFeedChunk(context, {
      type: "host_feed_chunk",
      sourceId: "host-a",
      sentAtMs: Date.now(),
      requestId: "req-a",
      invokeId: "invoke-a",
      hostId: "host-a",
      payloadKey: '{"id":3}',
      payloadHash: "hash-3",
      chunkType: "next",
      payload: { value: 1 },
      meta: { traceId: "host-meta" },
    });

    expect(sent).toHaveLength(2);
    const metaByTarget = new Map(sent.map((entry) => [entry.participantId, entry.message.meta]));
    expect(metaByTarget.get("invoke-a")).toEqual({ traceId: "trace-a" });
    expect(metaByTarget.get("invoke-b")).toEqual({ traceId: "trace-b" });
  });
});
