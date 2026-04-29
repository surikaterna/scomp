import assert from "node:assert/strict";
import { composeScompFragments, createContractToken, createScompFragment, createScompService } from "@scomp/core";
import { createJsonSerializer, RabbitMQTransport, StreamClosedError } from "../src";

const mockConnect = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock("node:crypto", () => ({
  randomUUID: (...args: Array<unknown>) => mockRandomUUID(...args),
}));

jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: (...args: Array<unknown>) => mockConnect(...args),
  },
  connect: (...args: Array<unknown>) => mockConnect(...args),
}));

type QueueConsumer = (message: unknown) => void | Promise<void>;

interface TestMessageOverride {
  content?: Buffer;
  properties?: {
    correlationId?: string;
    replyTo?: string;
  };
  fields?: {
    exchange?: string;
  };
}

function createFakeChannel() {
  const queueConsumers = new Map<string, QueueConsumer>();
  const eventHandlers = new Map<string, (message: unknown) => void>();
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
    on: jest.fn((eventName: string, handler: (message: unknown) => void) => {
      eventHandlers.set(eventName, handler);
      return channel;
    }),
  };

  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn(),
  };

  return {
    channel,
    connection,
    queueConsumers,
    eventHandlers,
  };
}

function createMessage(payload: unknown, overrides: TestMessageOverride = {}) {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    properties: {
      correlationId: overrides.properties?.correlationId ?? "corr-default",
      replyTo: overrides.properties?.replyTo ?? "reply-queue",
    },
    fields: {
      exchange: overrides.fields?.exchange ?? "",
    },
    ...overrides,
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

describe("RabbitMQTransport NFR behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let idCounter = 0;
    mockRandomUUID.mockImplementation(() => {
      idCounter += 1;
      return `id-${idCounter}`;
    });
  });

  it("supports feed fanout strategy with abort on basic.return", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const route = {
      route: "users.liveTicker",
      kind: "feed",
      strategy: "fanout",
      hashKey: () => "room-x",
      handler: async function* () {
        await new Promise<void>(() => {
          return;
        });
        yield { seq: 1 };
      },
    };

    const transport = new RabbitMQTransport({ url: "amqp://test" });
    await transport.registerRoutes({
      "users.liveTicker": route,
    } as unknown as Record<string, unknown>);

    const rpcConsumer = fake.queueConsumers.get("scomp.rpc.users");
    await rpcConsumer?.(
      createMessage({
        route: "users.liveTicker",
        op: "feed",
        payload: { room: "room-x" },
      }),
    );

    const running = (
      transport as unknown as {
        runningFeeds: Map<string, { abortController: AbortController }>;
      }
    ).runningFeeds.get("room-x");
    assert.equal(Boolean(running), true);

    const returnHandler = fake.eventHandlers.get("return");
    returnHandler?.({ fields: { exchange: "scomp.live.room-x" } });

    assert.equal(running.abortController.signal.aborted, true);
    assert.equal(running.abortController.signal.reason instanceof StreamClosedError, true);
  });

  it("keeps grouped and composed fragment routers transport-compatible", async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const groupedSignals: Array<unknown> = [];
    const grouped = createScompService<UsersContract>(createContractToken("users")).implement({
      requests: {
        getUser: async ({ id }: { id: number }) => ({ id, name: `u-${id}` }),
      },
      signals: {
        notifyLogin: async (payload: { id: number }) => {
          groupedSignals.push(payload);
        },
      },
      feeds: {
        liveUsers: {
          strategy: "fanout",
          hashKey: ({ room }: { room: string }) => room,
          handler: async function* () {
            yield { id: 1 };
          },
        },
      },
    });

    const composedSignals: Array<unknown> = [];
    const requestFragment = createScompFragment<UsersContract>("users").implement({
      requests: {
        getUser: async ({ id }: { id: number }) => ({ id, name: `u-${id}` }),
      },
    });
    const signalFragment = createScompFragment<UsersContract>("users").implement({
      signals: {
        notifyLogin: async (payload: { id: number }) => {
          composedSignals.push(payload);
        },
      },
    });
    const feedFragment = createScompFragment<UsersContract>("users").implement({
      feeds: {
        liveUsers: {
          strategy: "fanout",
          hashKey: ({ room }: { room: string }) => room,
          handler: async function* () {
            yield { id: 1 };
          },
        },
      },
    });
    const composed = composeScompFragments(requestFragment, signalFragment, feedFragment);

    const cases = [
      { router: grouped.router, seenSignals: groupedSignals },
      { router: composed.router, seenSignals: composedSignals },
    ];

    for (const { router, seenSignals } of cases) {
      const fake = createFakeChannel();
      mockConnect.mockResolvedValue(fake.connection);

      const transport = new RabbitMQTransport({ url: "amqp://test" });
      await transport.registerRoutes(router as unknown as Record<string, unknown>);

      // Intentional parity assertion: grouped/composed outputs still classify
      // request/signal/feed exactly as legacy transport dispatch expects.
      assert.equal(router["users.getUser"].kind, "request");
      assert.equal(router["users.notifyLogin"].kind, "signal");
      assert.equal(router["users.liveUsers"].kind, "feed");

      const rpcConsumer = fake.queueConsumers.get("scomp.rpc.users");
      assert.ok(rpcConsumer);

      await rpcConsumer?.(
        createMessage(
          {
            route: "users.getUser",
            op: "request",
            payload: { id: 7 },
          },
          {
            properties: {
              correlationId: "corr-request",
              replyTo: "reply-users",
            },
          },
        ),
      );

      const requestReply = fake.channel.sendToQueue.mock.calls.find(([queue]) => queue === "reply-users");
      assert.ok(requestReply);
      const requestBody = JSON.parse(Buffer.from(requestReply[1]).toString("utf8")) as { payload?: unknown };
      assert.deepEqual(requestBody.payload, { id: 7, name: "u-7" });

      const signalQueue = Array.from(fake.queueConsumers.keys()).find((queue) =>
        queue.startsWith("scomp.event.users."),
      );
      assert.ok(signalQueue);
      await fake.queueConsumers.get(String(signalQueue))?.(
        createMessage({
          route: "users.notifyLogin",
          op: "signal",
          payload: { id: 7 },
        }),
      );
      assert.deepEqual(seenSignals, [{ id: 7 }]);

      await rpcConsumer?.(
        createMessage(
          {
            route: "users.liveUsers",
            op: "feed",
            payload: { room: "general" },
          },
          {
            properties: {
              correlationId: "corr-feed-start",
              replyTo: "reply-users",
            },
          },
        ),
      );

      const feedStartReply = fake.channel.sendToQueue.mock.calls.find(
        ([queue, body]) =>
          queue === "reply-users" && String(Buffer.from(body).toString("utf8")).includes("scomp.live."),
      );
      assert.ok(feedStartReply);

      await waitFor(() => fake.channel.publish.mock.calls.length > 0);
      const firstChunk = JSON.parse(Buffer.from(fake.channel.publish.mock.calls[0][2]).toString("utf8")) as {
        type?: string;
        payload?: unknown;
      };
      assert.equal(firstChunk.type, "next");
      assert.deepEqual(firstChunk.payload, { id: 1 });
    }
  });

  it("supports pluggable serializer and custom content type", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const serializer = createJsonSerializer({
      contentType: "application/x-scomp-json+v1",
      replacer: (_key, value) => {
        if (typeof value === "bigint") {
          return { __type: "bigint", value: value.toString() };
        }
        return value;
      },
      reviver: (_key, value) => {
        const maybeTyped = value as { __type?: string; value?: string } | null;
        if (
          maybeTyped &&
          typeof maybeTyped === "object" &&
          maybeTyped.__type === "bigint" &&
          typeof maybeTyped.value === "string"
        ) {
          return BigInt(maybeTyped.value);
        }
        return value;
      },
    });

    const transport = new RabbitMQTransport({
      url: "amqp://test",
      serializer,
    });

    const pending = transport.request("users.getUser", { id: 9n });
    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);

    const [, body, options] = fake.channel.sendToQueue.mock.calls[0];
    assert.equal(options.contentType, "application/x-scomp-json+v1");

    const parsedBody = JSON.parse(Buffer.from(body).toString("utf8"));
    assert.deepEqual(parsedBody.payload.id, { __type: "bigint", value: "9" });

    const replyConsumer = fake.queueConsumers.get("generated-1");
    await replyConsumer?.(
      createMessage(
        { payload: { id: { __type: "bigint", value: "9" } } },
        {
          properties: { correlationId: "id-1", replyTo: "generated-1" },
        },
      ),
    );

    const resolved = await pending;
    assert.equal(typeof resolved.id, "bigint");
    assert.equal(resolved.id, 9n);
  });

  it("enforces max payload limits", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        maxPayloadBytes: 40,
      },
    });

    await assert.rejects(
      () => transport.request("users.getUser", { huge: "x".repeat(100) }),
      /Payload exceeds maxPayloadBytes/i,
    );
  });

  it("emits outbound priority decision observability events", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const events: Array<unknown> = [];
    const transport = new RabbitMQTransport({
      url: "amqp://test",
      observability: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    const pendingRequest = transport.request("users.getUser", { id: 1 }, { priorityClass: "P1" });
    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);

    const outboundRequestDecision = events.find(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "priority_decision" &&
        (event as { direction?: string }).direction === "outbound" &&
        (event as { operation?: string }).operation === "request",
    ) as
      | {
          route?: string;
          source?: string;
          requested?: string;
          effective?: string;
        }
      | undefined;
    assert.equal(outboundRequestDecision?.route, "users.getUser");
    assert.equal(outboundRequestDecision?.source, "metadata_hint");
    assert.equal(outboundRequestDecision?.requested, "P1");
    assert.equal(outboundRequestDecision?.effective, "P1");

    const [, , requestOptions] = fake.channel.sendToQueue.mock.calls[0];
    const replyConsumer = fake.queueConsumers.get("generated-1");
    await replyConsumer?.(
      createMessage(
        { payload: { ok: true } },
        {
          properties: {
            correlationId: requestOptions.correlationId,
            replyTo: requestOptions.replyTo,
          },
        },
      ),
    );
    await pendingRequest;

    await transport.signal("users.notifyLogin", { id: 1 }, { priorityClass: "P4" });
    const outboundSignalDecision = events.find(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "priority_decision" &&
        (event as { direction?: string }).direction === "outbound" &&
        (event as { operation?: string }).operation === "signal",
    ) as
      | {
          route?: string;
          source?: string;
          requested?: string;
          effective?: string;
        }
      | undefined;
    assert.equal(outboundSignalDecision?.route, "users.notifyLogin");
    assert.equal(outboundSignalDecision?.source, "metadata_hint");
    assert.equal(outboundSignalDecision?.requested, "P4");
    assert.equal(outboundSignalDecision?.effective, "P4");
  });

  it("emits inbound priority decision observability events", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const events: Array<unknown> = [];
    const seenSignals: Array<unknown> = [];
    const transport = new RabbitMQTransport({
      url: "amqp://test",
      observability: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    await transport.registerRoutes({
      "users.getUser": {
        route: "users.getUser",
        kind: "request",
        handler: async (payload: unknown) => payload,
      },
      "users.notifyLogin": {
        route: "users.notifyLogin",
        kind: "signal",
        handler: async (payload: unknown) => {
          seenSignals.push(payload);
        },
      },
    } as unknown as Record<string, unknown>);

    const rpcConsumer = fake.queueConsumers.get("scomp.rpc.users");
    await rpcConsumer?.(
      createMessage(
        {
          route: "users.getUser",
          op: "request",
          payload: { id: 3 },
          meta: { priority: "P0" },
        },
        {
          properties: {
            correlationId: "corr-inbound-request",
            replyTo: "reply-users",
          },
        },
      ),
    );

    const inboundRequestDecision = events.find(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "priority_decision" &&
        (event as { direction?: string }).direction === "inbound" &&
        (event as { operation?: string }).operation === "request",
    ) as
      | {
          route?: string;
          source?: string;
          requested?: string;
          effective?: string;
        }
      | undefined;
    assert.equal(inboundRequestDecision?.route, "users.getUser");
    assert.equal(inboundRequestDecision?.source, "metadata_hint");
    assert.equal(inboundRequestDecision?.requested, "P0");
    assert.equal(inboundRequestDecision?.effective, "P0");

    const signalQueue = Array.from(fake.queueConsumers.keys()).find((queue) => queue.startsWith("scomp.event.users."));
    assert.ok(signalQueue);
    await fake.queueConsumers.get(String(signalQueue))?.(
      createMessage({
        route: "users.notifyLogin",
        op: "signal",
        payload: { id: 7 },
        meta: { priorityClass: "P3" },
      }),
    );

    assert.deepEqual(seenSignals, [{ id: 7 }]);

    const inboundSignalDecision = events.find(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as { type?: string }).type === "priority_decision" &&
        (event as { direction?: string }).direction === "inbound" &&
        (event as { operation?: string }).operation === "signal",
    ) as
      | {
          route?: string;
          source?: string;
          requested?: string;
          effective?: string;
        }
      | undefined;
    assert.equal(inboundSignalDecision?.route, "users.notifyLogin");
    assert.equal(inboundSignalDecision?.source, "metadata_hint");
    assert.equal(inboundSignalDecision?.requested, "P3");
    assert.equal(inboundSignalDecision?.effective, "P3");
  });

  it("enforces max in-flight requests and request timeout", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({
      url: "amqp://test",
      performance: {
        maxInFlightRequests: 1,
        requestTimeoutMs: 5,
      },
    });

    const first = transport.request("users.getUser", { id: 1 });
    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);

    await assert.rejects(() => transport.request("users.getUser", { id: 2 }), /In-flight request limit/);
    await assert.rejects(() => first, /timed out/);
  });
});
