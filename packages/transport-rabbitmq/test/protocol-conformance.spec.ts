import assert from "node:assert/strict";
import type { CompiledRoute } from "@scomp/core";
import { RabbitMQTransport } from "../src";
import { createScompClient } from "@scomp/client";
import {
  WebSocketClientTransport,
  createNodeSocketAdapterFactory,
  SOCKET_OPEN,
} from "@scomp/transport-websocket-client";

const mockConnect = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock("node:crypto", () => {
  const actual = jest.requireActual("node:crypto");
  return {
    ...actual,
    randomUUID: (...args: Array<unknown>) => mockRandomUUID(...args),
  };
});

type QueueConsumer = (message: unknown) => void | Promise<void>;

jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: (...args: Array<unknown>) => mockConnect(...args),
  },
  connect: (...args: Array<unknown>) => mockConnect(...args),
}));

interface TestMessageOverride {
  content?: Buffer;
  properties?: {
    correlationId?: string;
    replyTo?: string;
  };
}

function createMessage(payload: unknown, overrides: TestMessageOverride = {}) {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    properties: {
      correlationId: overrides.properties?.correlationId ?? "corr-default",
      replyTo: overrides.properties?.replyTo ?? "reply-queue",
    },
    ...overrides,
  };
}

function createFakeChannel() {
  const queueConsumers = new Map<string, QueueConsumer>();
  let generatedQueueCounter = 0;

  const channel = {
    writable: true,
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn(async (name: string) => {
      if (name) {
        return { queue: name };
      }

      generatedQueueCounter += 1;
      return { queue: `generated-${generatedQueueCounter}` };
    }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    unbindQueue: jest.fn().mockResolvedValue(undefined),
    deleteQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn(async (queue: string, handler: QueueConsumer) => {
      queueConsumers.set(queue, handler);
      return { consumerTag: `consumer-${queue}` };
    }),
    cancel: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    publish: jest.fn(),
    ack: jest.fn(),
    on: jest.fn(),
  };

  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn(),
  };

  return {
    channel,
    connection,
    queueConsumers,
  };
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for condition.");
}

function stripId(payload: Record<string, unknown>) {
  const clone = { ...payload };
  delete clone.id;
  return clone;
}

const nodeSocketAdapter = createNodeSocketAdapterFactory();

function createPatchedWebSocketClient() {
  const client = new WebSocketClientTransport({ url: "ws://placeholder", socketAdapter: nodeSocketAdapter });
  const sentPayloads: Array<string> = [];

  const fakeSocket = {
    readyState: SOCKET_OPEN,
    send: (payload: string) => { sentPayloads.push(payload); },
    close: () => {},
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    removeAllHandlers: () => {},
  };

  (client as unknown as { socket: unknown }).socket = fakeSocket;
  (
    client as unknown as {
      getSocket: () => Promise<{ send: (payload: string) => void }>;
    }
  ).getSocket = async () => fakeSocket;

  return { client, sentPayloads };
}

interface CapturedUnaryRequest {
  rabbitFake: ReturnType<typeof createFakeChannel>;
  rabbitPending: Promise<unknown>;
  websocketPending: Promise<unknown>;
  websocketClient: WebSocketClientTransport;
  websocketRequest: Record<string, unknown>;
  rabbitRequest: Record<string, unknown>;
  rabbitRequestOptions: {
    correlationId: string;
    replyTo: string;
  };
}

async function captureUnaryRequest(
  route: string,
  payload: unknown,
): Promise<CapturedUnaryRequest> {
  const rabbitFake = createFakeChannel();
  mockConnect.mockResolvedValue(rabbitFake.connection);

  const rabbit = new RabbitMQTransport({ url: "amqp://test" });
  const websocket = createPatchedWebSocketClient();

  const rabbitPending = rabbit.request(route, payload);
  const websocketPending = websocket.client.request(route, payload);

  await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
  const rabbitRequestCall = rabbitFake.channel.sendToQueue.mock.calls[0];
  const rabbitRequest = JSON.parse(
    Buffer.from(rabbitRequestCall[1]).toString("utf8"),
  ) as Record<string, unknown>;
  const rabbitRequestOptions = rabbitRequestCall[2] as {
    correlationId: string;
    replyTo: string;
  };

  await waitFor(() => websocket.sentPayloads.length > 0);
  const websocketRequest = JSON.parse(websocket.sentPayloads[0]) as Record<
    string,
    unknown
  >;

  return {
    rabbitFake,
    rabbitPending,
    websocketPending,
    websocketClient: websocket.client,
    websocketRequest,
    rabbitRequest,
    rabbitRequestOptions,
  };
}

async function resolveCapturedUnaryRequest(
  captured: CapturedUnaryRequest,
  payload: unknown,
): Promise<{ websocket: unknown; rabbit: unknown }> {
  const websocketRequestId = String(captured.websocketRequest.id);
  (
    captured.websocketClient as unknown as {
      handleIncoming: (message: unknown) => void;
    }
  ).handleIncoming({
    id: websocketRequestId,
    payload,
  });

  const rabbitReplyConsumer =
    captured.rabbitFake.queueConsumers.get("generated-1");
  await rabbitReplyConsumer?.(
    createMessage(
      { payload },
      {
        properties: {
          correlationId: captured.rabbitRequestOptions.correlationId,
          replyTo: captured.rabbitRequestOptions.replyTo,
        },
      },
    ),
  );

  return {
    websocket: await captured.websocketPending,
    rabbit: await captured.rabbitPending,
  };
}

describe("Protocol conformance across websocket and rabbitmq", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let idCounter = 0;
    mockRandomUUID.mockImplementation(() => {
      idCounter += 1;
      return `id-${idCounter}`;
    });
  });

  it("encodes identical signal envelope shape", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: "amqp://test" });
    const websocket = createPatchedWebSocketClient();

    await Promise.all([
      rabbit.signal("users.notify", { id: 7 }),
      websocket.client.signal("users.notify", { id: 7 }),
    ]);

    const rabbitPublishCall = rabbitFake.channel.publish.mock.calls[0];
    const rabbitEnvelope = JSON.parse(
      Buffer.from(rabbitPublishCall[2]).toString("utf8"),
    );
    const websocketEnvelope = JSON.parse(websocket.sentPayloads[0]);

    assert.deepEqual(websocketEnvelope, rabbitEnvelope);
  });

  it("encodes identical signal envelope shape when metadata is present", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authenticate: () => ({
            subject: "user-1",
            tenantId: "tenant-a",
          }),
        },
      },
    });
    const websocket = new WebSocketClientTransport({
      url: "ws://placeholder",
      socketAdapter: nodeSocketAdapter,
      meta: {
        traceId: "trace-1",
      },
      security: {
        authenticate: () => ({
          subject: "user-1",
          tenantId: "tenant-a",
        }),
      },
    });

    const sentPayloads: Array<string> = [];
    const wsSocket = {
      readyState: SOCKET_OPEN,
      send: (payload: string) => { sentPayloads.push(payload); },
      close: () => {},
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
      removeAllHandlers: () => {},
    };
    (websocket as unknown as { socket: unknown }).socket = wsSocket;
    (
      websocket as unknown as {
        getSocket: () => Promise<{ send: (payload: string) => void }>;
      }
    ).getSocket = async () => wsSocket;

    await Promise.all([
      rabbit.signal("users.notify", { id: 7 }),
      websocket.signal("users.notify", { id: 7 }),
    ]);

    const rabbitPublishCall = rabbitFake.channel.publish.mock.calls[0];
    const rabbitEnvelope = JSON.parse(
      Buffer.from(rabbitPublishCall[2]).toString("utf8"),
    );
    const websocketEnvelope = JSON.parse(sentPayloads[0]);

    assert.equal(typeof rabbitEnvelope.meta.auth.subject, "string");
    assert.equal(
      rabbitEnvelope.meta.auth.subject,
      websocketEnvelope.meta.auth.subject,
    );
    assert.equal(websocketEnvelope.meta.traceId, "trace-1");
  });

  it("encodes request envelopes with equivalent shape after transport metadata normalization", async () => {
    const captured = await captureUnaryRequest("users.get", { id: 9 });

    assert.deepEqual(
      stripId(captured.websocketRequest),
      captured.rabbitRequest,
    );

    const result = await resolveCapturedUnaryRequest(captured, { ok: true });
    assert.deepEqual(result.websocket, { ok: true });
    assert.deepEqual(result.rabbit, { ok: true });
  });

  it("encodes discover control-plane requests consistently across transports", async () => {
    const captured = await captureUnaryRequest("__scomp.discover", {
      servicePrefix: "users",
      includeRoutes: true,
    });

    assert.deepEqual(
      stripId(captured.websocketRequest),
      captured.rabbitRequest,
    );

    const discoverResponse = {
      services: [
        {
          name: "users",
          routes: ["users.getUser", "users.list"],
        },
      ],
      node: { id: "node-a" },
      generatedAt: "2026-03-28T15:00:00.000Z",
      ttlMs: 1500,
    };
    const result = await resolveCapturedUnaryRequest(
      captured,
      discoverResponse,
    );

    assert.deepEqual(result.websocket, discoverResponse);
    assert.deepEqual(result.rabbit, discoverResponse);
  });

  it("encodes resolve control-plane requests with fallback semantics consistently", async () => {
    const captured = await captureUnaryRequest("__scomp.resolve", {
      route: "users.getUser",
      channel: "ws:alternate",
    });

    assert.deepEqual(
      stripId(captured.websocketRequest),
      captured.rabbitRequest,
    );

    const resolveResponse = {
      resolved: true,
      fallbackUsed: true,
      endpoint: {
        route: "users.getUser",
        channel: "current-channel",
        transport: "websocket",
      },
      candidates: [
        {
          route: "users.getUser",
          channel: "ws:alternate",
          transport: "websocket",
        },
        {
          route: "users.getUser",
          channel: "current-channel",
          transport: "websocket",
        },
      ],
    };
    const result = await resolveCapturedUnaryRequest(captured, resolveResponse);

    assert.deepEqual(result.websocket, resolveResponse);
    assert.deepEqual(result.rabbit, resolveResponse);
    assert.equal(
      (result.websocket as { fallbackUsed: boolean }).fallbackUsed,
      true,
    );
    assert.equal(
      (result.rabbit as { fallbackUsed: boolean }).fallbackUsed,
      true,
    );
  });

  it("encodes health control-plane requests consistently across transports", async () => {
    const captured = await captureUnaryRequest("__scomp.health", {
      mode: "deep",
      verbose: true,
      service: "users",
    });

    assert.deepEqual(
      stripId(captured.websocketRequest),
      captured.rabbitRequest,
    );

    const healthResponse = {
      status: "ok",
      checks: [
        {
          name: "users.db",
          status: "ok",
        },
      ],
      node: { id: "node-health" },
      timestamp: "2026-03-28T16:00:00.000Z",
    };
    const result = await resolveCapturedUnaryRequest(captured, healthResponse);

    assert.deepEqual(result.websocket, healthResponse);
    assert.deepEqual(result.rabbit, healthResponse);
  });

  it("preserves explicit priority metadata across websocket and rabbitmq request envelopes", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authenticate: () => ({
            subject: "principal-rabbit",
          }),
        },
      },
    });

    const websocketClient = new WebSocketClientTransport({
      url: "ws://placeholder",
      socketAdapter: nodeSocketAdapter,
      meta: {
        traceId: "trace-priority",
        priority: "P1",
        priorityClass: "P2",
        tags: {
          priority: "P3",
        },
      },
    });

    const sentPayloads: Array<string> = [];
    const wsSocket3 = {
      readyState: SOCKET_OPEN,
      send: (payload: string) => { sentPayloads.push(payload); },
      close: () => {},
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
      removeAllHandlers: () => {},
    };
    (websocketClient as unknown as { socket: unknown }).socket = wsSocket3;
    (
      websocketClient as unknown as {
        getSocket: () => Promise<{ send: (payload: string) => void }>;
      }
    ).getSocket = async () => wsSocket3;

    const rabbitPending = rabbit.request("users.get", { id: 11 });
    const websocketPending = websocketClient.request("users.get", { id: 11 });

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => sentPayloads.length > 0);

    const rabbitRequest = JSON.parse(
      Buffer.from(rabbitFake.channel.sendToQueue.mock.calls[0][1]).toString(
        "utf8",
      ),
    ) as {
      meta?: {
        auth?: { subject?: string };
      };
    };

    const websocketRequest = JSON.parse(sentPayloads[0]) as {
      id?: string;
      meta?: {
        traceId?: string;
        priority?: string;
        priorityClass?: string;
        tags?: { priority?: string };
      };
    };

    assert.equal(rabbitRequest.meta?.auth?.subject, "principal-rabbit");
    assert.equal(websocketRequest.meta?.traceId, "trace-priority");
    assert.equal(websocketRequest.meta?.priority, "P1");
    assert.equal(websocketRequest.meta?.priorityClass, "P2");
    assert.equal(websocketRequest.meta?.tags?.priority, "P3");

    const rabbitRequestOptions = rabbitFake.channel.sendToQueue.mock
      .calls[0][2] as {
      correlationId: string;
      replyTo: string;
    };
    const rabbitReplyConsumer = rabbitFake.queueConsumers.get("generated-1");
    await rabbitReplyConsumer?.(
      createMessage(
        { payload: { ok: true } },
        {
          properties: {
            correlationId: rabbitRequestOptions.correlationId,
            replyTo: rabbitRequestOptions.replyTo,
          },
        },
      ),
    );

    (
      websocketClient as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: String(websocketRequest.id),
      payload: { ok: true },
    });

    assert.deepEqual(await rabbitPending, { ok: true });
    assert.deepEqual(await websocketPending, { ok: true });
  });

  it("keeps websocket request metadata absent when no hints are configured", async () => {
    const websocket = createPatchedWebSocketClient();

    const pending = websocket.client.request("users.get", { id: 5 });

    await waitFor(() => websocket.sentPayloads.length > 0);
    const requestEnvelope = JSON.parse(websocket.sentPayloads[0]) as {
      id: string;
      meta?: unknown;
    };

    assert.equal(requestEnvelope.meta, undefined);

    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: requestEnvelope.id,
      payload: { ok: true },
    });

    assert.deepEqual(await pending, { ok: true });
  });

  it("allows per-call priority overrides through client proxy options", async () => {
    const websocket = createPatchedWebSocketClient();
    const client = createScompClient<{
      users: {
        get: (input: { id: number }) => Promise<{ ok: boolean }>;
      };
    }>({
      transport: websocket.client,
      routeHints: {
        "users.get": "request",
      },
    });

    const pending = client.users.get(
      { id: 17 },
      {
        priority: "P0",
        priorityClass: "P1",
        deadlineAtMs: 999,
        targetLatencyMs: 25,
        meta: {
          traceId: "trace-proxy",
          tags: {
            source: "proxy",
          },
        },
      },
    );

    await waitFor(() => websocket.sentPayloads.length > 0);
    const envelope = JSON.parse(websocket.sentPayloads[0]) as {
      id: string;
      payload: { id: number };
      meta?: {
        traceId?: string;
        priority?: string;
        priorityClass?: string;
        deadlineAtMs?: number;
        targetLatencyMs?: number;
        tags?: { source?: string };
      };
    };

    assert.deepEqual(envelope.payload, { id: 17 });
    assert.equal(envelope.meta?.traceId, "trace-proxy");
    assert.equal(envelope.meta?.priority, "P0");
    assert.equal(envelope.meta?.priorityClass, "P1");
    assert.equal(envelope.meta?.deadlineAtMs, 999);
    assert.equal(envelope.meta?.targetLatencyMs, 25);
    assert.equal(envelope.meta?.tags?.source, "proxy");

    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: envelope.id,
      payload: { ok: true },
    });

    assert.deepEqual(await pending, { ok: true });
  });

  it("applies route default priority metadata through client route options", async () => {
    const websocket = createPatchedWebSocketClient();
    const client = createScompClient<{
      users: {
        get: (input: { id: number }) => Promise<{ ok: boolean }>;
      };
    }>({
      transport: websocket.client,
      routeHints: {
        "users.get": "request",
      },
      routeOptions: {
        "users.get": {
          priority: "P2",
          meta: {
            traceId: "trace-default",
          },
        },
      },
    });

    const pending = client.users.get({ id: 3 });

    await waitFor(() => websocket.sentPayloads.length > 0);
    const envelope = JSON.parse(websocket.sentPayloads[0]) as {
      id: string;
      meta?: {
        traceId?: string;
        priority?: string;
      };
    };

    assert.equal(envelope.meta?.traceId, "trace-default");
    assert.equal(envelope.meta?.priority, "P2");

    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: envelope.id,
      payload: { ok: true },
    });

    assert.deepEqual(await pending, { ok: true });
  });

  it("lets per-call options override route defaults", async () => {
    const websocket = createPatchedWebSocketClient();
    const client = createScompClient<{
      users: {
        get: (input: { id: number }) => Promise<{ ok: boolean }>;
      };
    }>({
      transport: websocket.client,
      routeHints: {
        "users.get": "request",
      },
      routeOptions: {
        "users.get": {
          priority: "P3",
          meta: {
            traceId: "trace-default",
          },
        },
      },
    });

    const pending = client.users.get(
      { id: 8 },
      {
        priority: "P0",
        meta: {
          traceId: "trace-override",
        },
      },
    );

    await waitFor(() => websocket.sentPayloads.length > 0);
    const envelope = JSON.parse(websocket.sentPayloads[0]) as {
      id: string;
      meta?: {
        traceId?: string;
        priority?: string;
      };
    };

    assert.equal(envelope.meta?.traceId, "trace-override");
    assert.equal(envelope.meta?.priority, "P0");

    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: envelope.id,
      payload: { ok: true },
    });

    assert.deepEqual(await pending, { ok: true });
  });

  it("encodes feed and unsubscribe envelopes consistently across transports", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: "amqp://test" });
    const websocket = createPatchedWebSocketClient();

    const rabbitIterator = rabbit
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();
    const websocketIterator = websocket.client
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();

    const rabbitNext = rabbitIterator.next();
    const websocketNext = websocketIterator.next();

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => websocket.sentPayloads.length > 0);

    const rabbitFeedStartCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitFeedStartEnvelope = JSON.parse(
      Buffer.from(rabbitFeedStartCall[1]).toString("utf8"),
    ) as Record<string, unknown>;
    const websocketFeedStartEnvelope = JSON.parse(
      websocket.sentPayloads[0],
    ) as Record<string, unknown>;

    assert.deepEqual(
      stripId(websocketFeedStartEnvelope),
      rabbitFeedStartEnvelope,
    );

    const rabbitFeedStartOptions = rabbitFeedStartCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    const rabbitReplyConsumer = rabbitFake.queueConsumers.get("generated-1");
    const feedHash = "feed-alpha";
    const feedExchange = `scomp.live.${feedHash}`;

    await rabbitReplyConsumer?.(
      createMessage(
        {
          payload: {
            exchange: feedExchange,
            feed: feedHash,
          },
        },
        {
          properties: {
            correlationId: rabbitFeedStartOptions.correlationId,
            replyTo: rabbitFeedStartOptions.replyTo,
          },
        },
      ),
    );
    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: String(websocketFeedStartEnvelope.id),
      payload: {
        exchange: feedExchange,
        feed: feedHash,
      },
    });

    await waitFor(() => rabbitFake.queueConsumers.has("generated-2"));

    const rabbitFeedConsumer = rabbitFake.queueConsumers.get("generated-2");
    await rabbitFeedConsumer?.(
      createMessage({
        channel: "feed",
        feed: feedHash,
        type: "next",
        payload: { seq: 1 },
      }),
    );
    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      channel: "feed",
      feed: feedHash,
      type: "next",
      payload: { seq: 1 },
    });

    const [rabbitFirst, websocketFirst] = await Promise.all([
      rabbitNext,
      websocketNext,
    ]);
    assert.deepEqual(rabbitFirst.value, { seq: 1 });
    assert.equal(rabbitFirst.done, false);
    assert.deepEqual(websocketFirst.value, { seq: 1 });
    assert.equal(websocketFirst.done, false);

    const rabbitReturnPromise = rabbitIterator.return?.(undefined);
    const websocketReturnPromise = websocketIterator.return?.(undefined);

    if (!rabbitReturnPromise || !websocketReturnPromise) {
      throw new Error("Feed iterators do not support return().");
    }

    // In v2, feed unsubscribe is a fire-and-forget signal — no response needed.
    const [rabbitReturn, websocketReturn] = await Promise.all([
      rabbitReturnPromise,
      websocketReturnPromise,
    ]);

    assert.equal(rabbitReturn.done, true);
    assert.equal(websocketReturn.done, true);

    // RabbitMQ unsubscribe goes through signal() → channel.publish
    await waitFor(() => rabbitFake.channel.publish.mock.calls.length > 0);
    const rabbitUnsubCall = rabbitFake.channel.publish.mock.calls[0];
    const rabbitUnsubEnvelope = JSON.parse(
      Buffer.from(rabbitUnsubCall[2]).toString("utf8"),
    ) as Record<string, unknown>;
    assert.equal(rabbitUnsubEnvelope.op, "signal");

    // WS client sends fire-and-forget JSON signal
    await waitFor(() => websocket.sentPayloads.length > 1);
    const websocketUnsubEnvelope = JSON.parse(
      websocket.sentPayloads[1],
    ) as Record<string, unknown>;
    assert.equal(websocketUnsubEnvelope.op, "signal");
    assert.equal(websocketUnsubEnvelope.method, "__scomp.unsubscribe");
  });

  it("propagates feed error chunks with consistent rejections", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: "amqp://test" });
    const websocket = createPatchedWebSocketClient();

    const rabbitIterator = rabbit
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();
    const websocketIterator = websocket.client
      .feed("users.live", { room: "alpha" })
      [Symbol.asyncIterator]();

    const rabbitNext = rabbitIterator.next();
    const websocketNext = websocketIterator.next();

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => websocket.sentPayloads.length > 0);

    const rabbitFeedStartCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitFeedStartOptions = rabbitFeedStartCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    const websocketFeedStartEnvelope = JSON.parse(
      websocket.sentPayloads[0],
    ) as {
      id: string;
    };

    const rabbitReplyConsumer = rabbitFake.queueConsumers.get("generated-1");
    const feedHash = "feed-error";
    const feedExchange = `scomp.live.${feedHash}`;

    await rabbitReplyConsumer?.(
      createMessage(
        {
          payload: {
            exchange: feedExchange,
            feed: feedHash,
          },
        },
        {
          properties: {
            correlationId: rabbitFeedStartOptions.correlationId,
            replyTo: rabbitFeedStartOptions.replyTo,
          },
        },
      ),
    );
    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: websocketFeedStartEnvelope.id,
      payload: {
        exchange: feedExchange,
        feed: feedHash,
      },
    });

    await waitFor(() => rabbitFake.queueConsumers.has("generated-2"));
    const rabbitFeedConsumer = rabbitFake.queueConsumers.get("generated-2");

    await rabbitFeedConsumer?.(
      createMessage({
        channel: "feed",
        feed: feedHash,
        type: "error",
        message: "feed exploded",
      }),
    );
    (
      websocket.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      channel: "feed",
      feed: feedHash,
      type: "error",
      message: "feed exploded",
    });

    // In v2, feed error triggers the iterator's finally block which sends
    // a fire-and-forget unsubscribe signal — no response handshake needed.
    await assert.rejects(() => rabbitNext, /feed exploded/);
    await assert.rejects(() => websocketNext, /feed exploded/);
  });

  it("produces rabbit feed chunks that websocket feed decoder accepts", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: "amqp://test" });
    await rabbit.registerRoutes({
      "users.live": {
        route: "users.live",
        kind: "feed",
        strategy: "fanout",
        handler: async function* () {
          yield { seq: 1 };
        },
      },
    } as Record<string, CompiledRoute>);

    const rpcConsumer = rabbitFake.queueConsumers.get("scomp.rpc.users");
    await rpcConsumer?.(
      createMessage({
        route: "users.live",
        op: "feed",
        payload: { room: "alpha" },
      }),
    );

    await waitFor(() => rabbitFake.channel.publish.mock.calls.length >= 2);

    const firstChunk = JSON.parse(
      Buffer.from(rabbitFake.channel.publish.mock.calls[0][2]).toString("utf8"),
    );
    assert.equal(firstChunk.channel, "feed");
    assert.equal(firstChunk.type, "next");
    assert.equal(typeof firstChunk.feed, "string");

    const websocket = createPatchedWebSocketClient().client as unknown as {
      feeds: Map<string, unknown>;
      handleIncoming: (message: unknown) => void;
    };

    const feedState = {
      queue: [] as Array<unknown | Promise<never>>,
      waiters: [] as Array<() => void>,
      closed: false,
    };

    websocket.feeds.set(firstChunk.feed, feedState);
    websocket.handleIncoming(firstChunk);
    assert.deepEqual(feedState.queue[0], { seq: 1 });

    const doneChunk = JSON.parse(
      Buffer.from(rabbitFake.channel.publish.mock.calls[1][2]).toString("utf8"),
    );
    websocket.handleIncoming(doneChunk);
    assert.equal(feedState.closed, true);
  });
});
