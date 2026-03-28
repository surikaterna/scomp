import assert from "node:assert/strict";
import {
  createJsonSerializer,
  RabbitMQTransport,
  StreamClosedError,
} from "../src";

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
    await transport.listen({ "users.liveTicker": route } as unknown as Record<
      string,
      unknown
    >);

    const rpcConsumer = fake.queueConsumers.get("scomp.rpc.users");
    await rpcConsumer?.(
      createMessage({
        route: "users.liveTicker",
        op: "feed_start",
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
    assert.equal(
      running.abortController.signal.reason instanceof StreamClosedError,
      true,
    );
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

  it("enforces security policy and max payload limits", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const events: Array<string> = [];
    const transport = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        maxPayloadBytes: 40,
        authorize: ({ route }) => route !== "blocked.route",
      },
      observability: {
        onEvent: (event) => {
          events.push(event.type);
        },
      },
    });

    await assert.rejects(
      () => transport.request("blocked.route", { ok: true }),
      /not authorized/i,
    );
    await assert.rejects(
      () => transport.request("users.getUser", { huge: "x".repeat(100) }),
      /Payload exceeds maxPayloadBytes/i,
    );

    assert.equal(events.includes("security_denied"), true);
  });

  it("uses shared security policy context with optional message meta", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const seen: Array<{
      route: string;
      operation: string;
      direction: string;
      hasMeta: boolean;
    }> = [];
    const transport = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authenticate: ({ route }) => ({
            subject: `subject:${route}`,
            scopes: ["rpc:invoke"],
          }),
          authorize: (ctx) => {
            seen.push({
              route: ctx.route,
              operation: ctx.operation,
              direction: ctx.direction,
              hasMeta: Boolean(ctx.meta),
            });
            return ctx.route !== "blocked.route";
          },
        },
      },
    });

    await assert.rejects(
      () => transport.request("blocked.route", { ok: true }),
      /not authorized/i,
    );

    const pending = transport.request("users.getUser", { id: 3 });
    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);

    const [, body, options] = fake.channel.sendToQueue.mock.calls[0];
    const parsedBody = JSON.parse(Buffer.from(body).toString("utf8"));
    assert.equal(typeof parsedBody.meta, "object");
    assert.equal(parsedBody.meta.auth.subject, "subject:users.getUser");

    const replyConsumer = fake.queueConsumers.get("generated-1");
    await replyConsumer?.(
      createMessage(
        { payload: { ok: true } },
        {
          properties: {
            correlationId: options.correlationId,
            replyTo: options.replyTo,
          },
        },
      ),
    );
    await pending;

    assert.equal(
      seen.some(
        (entry) =>
          entry.route === "blocked.route" && entry.direction === "outbound",
      ),
      true,
    );
    assert.equal(
      seen.some(
        (entry) => entry.route === "users.getUser" && entry.hasMeta === false,
      ),
      true,
    );
  });

  it("propagates inbound priority metadata to security policy", async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const seenMeta: Array<unknown> = [];
    const transport = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authorize: (ctx) => {
            seenMeta.push(ctx.meta);
            return true;
          },
        },
      },
    });

    await transport.listen({
      "users.getUser": {
        route: "users.getUser",
        kind: "request",
        handler: async (payload: unknown) => payload,
      },
    } as unknown as Record<string, unknown>);

    const rpcConsumer = fake.queueConsumers.get("scomp.rpc.users");
    await rpcConsumer?.(
      createMessage(
        {
          route: "users.getUser",
          op: "request",
          payload: { id: 1 },
          meta: {
            priority: "P1",
            priorityClass: "P2",
            tags: {
              priority: "P3",
            },
          },
        },
        {
          properties: {
            correlationId: "corr-priority-1",
            replyTo: "reply-priority",
          },
        },
      ),
    );

    await rpcConsumer?.(
      createMessage(
        {
          route: "users.getUser",
          op: "request",
          payload: { id: 2 },
        },
        {
          properties: {
            correlationId: "corr-priority-2",
            replyTo: "reply-priority",
          },
        },
      ),
    );

    const explicitMeta = seenMeta.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { priority?: string }).priority === "P1",
    ) as
      | {
          priority?: string;
          priorityClass?: string;
          tags?: { priority?: string };
        }
      | undefined;

    assert.equal(explicitMeta?.priority, "P1");
    assert.equal(explicitMeta?.priorityClass, "P2");
    assert.equal(explicitMeta?.tags?.priority, "P3");
    assert.equal(seenMeta.some((entry) => entry === undefined), true);
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

    await assert.rejects(
      () => transport.request("users.getUser", { id: 2 }),
      /In-flight request limit/,
    );
    await assert.rejects(() => first, /timed out/);
  });
});
