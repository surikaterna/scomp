import assert from "node:assert/strict";
import { RabbitMQTransport } from "../src";
import { WebSocketClientTransport } from "../../transport-websocket-client/src";
import { WebSocketBrowserTransport } from "../../transport-websocket-browser/src";

const mockConnect = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock("node:crypto", () => {
  const actual = jest.requireActual("node:crypto");
  return {
    ...actual,
    randomUUID: (...args: Array<unknown>) => mockRandomUUID(...args),
  };
});

jest.mock("amqplib", () => ({
  __esModule: true,
  default: {
    connect: (...args: Array<unknown>) => mockConnect(...args),
  },
  connect: (...args: Array<unknown>) => mockConnect(...args),
}));

type QueueConsumer = (message: unknown) => void | Promise<void>;

interface TestMessageOverride {
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

class FakeBrowserSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  public readyState = FakeBrowserSocket.CONNECTING;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  private readonly sent: Array<string>;

  constructor(sent: Array<string>) {
    this.sent = sent;
    queueMicrotask(() => {
      this.readyState = FakeBrowserSocket.OPEN;
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

function createPatchedWebSocketClient() {
  const client = new WebSocketClientTransport({
    url: "ws://placeholder",
    security: {
      authenticate: () => ({
        subject: "subject:runtime",
        tenantId: "tenant-runtime",
        claims: { role: "tester" },
      }),
    },
  });
  const sentPayloads: Array<string> = [];

  (
    client as unknown as {
      getSocket: () => Promise<{ send: (payload: string) => void }>;
    }
  ).getSocket = async () => ({
    send: (payload: string) => {
      sentPayloads.push(payload);
    },
  });

  return { client, sentPayloads };
}

function createPatchedBrowserClient() {
  const sentPayloads: Array<string> = [];
  let socket: FakeBrowserSocket | undefined;

  const webSocketCtor = class {
    constructor(_url: string, _protocols?: string | Array<string>) {
      socket = new FakeBrowserSocket(sentPayloads);
      return socket;
    }
  } as unknown as new (
    url: string,
    protocols?: string | Array<string>,
  ) => WebSocket;

  const client = new WebSocketBrowserTransport({
    url: "ws://placeholder",
    security: {
      authenticate: () => ({
        subject: "subject:runtime",
        tenantId: "tenant-runtime",
        claims: { role: "tester" },
      }),
    },
    webSocketCtor,
  });

  return {
    client,
    sentPayloads,
    getSocket: () => {
      if (!socket) {
        throw new Error("Expected browser socket to exist");
      }
      return socket;
    },
  };
}

function stripId(payload: Record<string, unknown>) {
  const clone = { ...payload };
  delete clone.id;
  return clone;
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

describe("Cross-runtime conformance: browser websocket, node websocket, rabbitmq", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let idCounter = 0;
    mockRandomUUID.mockImplementation(() => {
      idCounter += 1;
      return `id-${idCounter}`;
    });
  });

  it("keeps request/signal metadata, priority, and auth context aligned", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authenticate: () => ({
            subject: "subject:runtime",
            tenantId: "tenant-runtime",
            claims: { role: "tester" },
          }),
        },
      },
    });
    const node = createPatchedWebSocketClient();
    const browser = createPatchedBrowserClient();

    const invokeOptions = {
      meta: {
        traceId: "trace-runtime",
        tenantId: "tenant-override",
        tags: { source: "conformance" },
      },
      priority: "P0" as const,
      priorityClass: "P1" as const,
      deadlineAtMs: 1500,
      targetLatencyMs: 40,
    };

    const rabbitPending = rabbit.request("users.get", { id: 10 }, invokeOptions);
    const nodePending = node.client.request("users.get", { id: 10 }, invokeOptions);
    const browserPending = browser.client.request(
      "users.get",
      { id: 10 },
      invokeOptions,
    );

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => node.sentPayloads.length > 0);
    await waitFor(() => browser.sentPayloads.length > 0);

    const rabbitRequestCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitRequest = JSON.parse(
      Buffer.from(rabbitRequestCall[1]).toString("utf8"),
    ) as Record<string, unknown>;
    const nodeRequest = JSON.parse(node.sentPayloads[0]) as Record<string, unknown>;
    const browserRequest = JSON.parse(
      browser.sentPayloads[0],
    ) as Record<string, unknown>;

    assert.deepEqual(stripId(nodeRequest), rabbitRequest);
    assert.deepEqual(stripId(browserRequest), rabbitRequest);

    const rabbitRequestOptions = rabbitRequestCall[2] as {
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
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: String(nodeRequest.id),
      payload: { ok: true },
    });

    browser.getSocket().emit("message", {
      data: JSON.stringify({
        id: String(browserRequest.id),
        payload: { ok: true },
      }),
    });

    assert.deepEqual(await rabbitPending, { ok: true });
    assert.deepEqual(await nodePending, { ok: true });
    assert.deepEqual(await browserPending, { ok: true });

    await Promise.all([
      rabbit.signal("users.notify", { id: 99 }, invokeOptions),
      node.client.signal("users.notify", { id: 99 }, invokeOptions),
      browser.client.signal("users.notify", { id: 99 }, invokeOptions),
    ]);

    const rabbitSignal = JSON.parse(
      Buffer.from(rabbitFake.channel.publish.mock.calls[0][2]).toString("utf8"),
    ) as Record<string, unknown>;
    const nodeSignal = JSON.parse(node.sentPayloads[1]) as Record<string, unknown>;
    const browserSignal = JSON.parse(
      browser.sentPayloads[1],
    ) as Record<string, unknown>;

    assert.deepEqual(nodeSignal, rabbitSignal);
    assert.deepEqual(browserSignal, rabbitSignal);
  });

  it("keeps feed_start/feed_stop metadata and lifecycle semantics aligned", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({
      url: "amqp://test",
      security: {
        policy: {
          authenticate: () => ({
            subject: "subject:runtime",
            tenantId: "tenant-runtime",
            claims: { role: "tester" },
          }),
        },
      },
    });
    const node = createPatchedWebSocketClient();
    const browser = createPatchedBrowserClient();

    const invokeOptions = {
      meta: {
        traceId: "trace-runtime",
        tenantId: "tenant-override",
        tags: { source: "conformance" },
      },
      priority: "P2" as const,
      priorityClass: "P3" as const,
      deadlineAtMs: 2500,
      targetLatencyMs: 60,
    };

    const rabbitIterator = rabbit
      .feed("users.live", { room: "alpha" }, invokeOptions)
      [Symbol.asyncIterator]();
    const nodeIterator = node.client
      .feed("users.live", { room: "alpha" }, invokeOptions)
      [Symbol.asyncIterator]();
    const browserIterator = browser.client
      .feed("users.live", { room: "alpha" }, invokeOptions)
      [Symbol.asyncIterator]();

    const rabbitNext = rabbitIterator.next();
    const nodeNext = nodeIterator.next();
    const browserNext = browserIterator.next();

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => node.sentPayloads.length > 0);
    await waitFor(() => browser.sentPayloads.length > 0);

    const rabbitFeedStartCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitFeedStart = JSON.parse(
      Buffer.from(rabbitFeedStartCall[1]).toString("utf8"),
    ) as Record<string, unknown>;
    const nodeFeedStart = JSON.parse(node.sentPayloads[0]) as Record<string, unknown>;
    const browserFeedStart = JSON.parse(
      browser.sentPayloads[0],
    ) as Record<string, unknown>;

    assert.deepEqual(stripId(nodeFeedStart), rabbitFeedStart);
    assert.deepEqual(stripId(browserFeedStart), rabbitFeedStart);

    const rabbitFeedStartOptions = rabbitFeedStartCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    const rabbitReplyConsumer = rabbitFake.queueConsumers.get("generated-1");
    const feedHash = "feed-runtime";
    const feedExchange = `scomp.live.${feedHash}`;

    await rabbitReplyConsumer?.(
      createMessage(
        {
          payload: {
            exchange: feedExchange,
            hash: feedHash,
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
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: String(nodeFeedStart.id),
      payload: { exchange: feedExchange, hash: feedHash },
    });

    browser.getSocket().emit("message", {
      data: JSON.stringify({
        id: String(browserFeedStart.id),
        payload: { exchange: feedExchange, hash: feedHash },
      }),
    });

    await waitFor(() => rabbitFake.queueConsumers.has("generated-2"));
    const rabbitFeedConsumer = rabbitFake.queueConsumers.get("generated-2");

    await rabbitFeedConsumer?.(
      createMessage({
        channel: "feed",
        hash: feedHash,
        type: "next",
        payload: { seq: 1 },
      }),
    );
    (
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      channel: "feed",
      hash: feedHash,
      type: "next",
      payload: { seq: 1 },
    });
    browser.getSocket().emit("message", {
      data: JSON.stringify({
        channel: "feed",
        hash: feedHash,
        type: "next",
        payload: { seq: 1 },
      }),
    });

    const [rabbitFirst, nodeFirst, browserFirst] = await Promise.all([
      rabbitNext,
      nodeNext,
      browserNext,
    ]);
    assert.equal(rabbitFirst.done, false);
    assert.equal(nodeFirst.done, false);
    assert.equal(browserFirst.done, false);
    assert.deepEqual(rabbitFirst.value, { seq: 1 });
    assert.deepEqual(nodeFirst.value, { seq: 1 });
    assert.deepEqual(browserFirst.value, { seq: 1 });

    const rabbitReturn = rabbitIterator.return?.(undefined);
    const nodeReturn = nodeIterator.return?.(undefined);
    const browserReturn = browserIterator.return?.(undefined);

    if (!rabbitReturn || !nodeReturn || !browserReturn) {
      throw new Error("Feed iterators must support return().");
    }

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 1);
    await waitFor(() => node.sentPayloads.length > 1);
    await waitFor(() => browser.sentPayloads.length > 1);

    const rabbitFeedStopCall = rabbitFake.channel.sendToQueue.mock.calls[1];
    const rabbitFeedStop = JSON.parse(
      Buffer.from(rabbitFeedStopCall[1]).toString("utf8"),
    ) as Record<string, unknown>;
    const nodeFeedStop = JSON.parse(node.sentPayloads[1]) as Record<string, unknown>;
    const browserFeedStop = JSON.parse(
      browser.sentPayloads[1],
    ) as Record<string, unknown>;

    assert.deepEqual(stripId(nodeFeedStop), rabbitFeedStop);
    assert.deepEqual(stripId(browserFeedStop), rabbitFeedStop);
    assert.deepEqual((nodeFeedStop as { meta?: unknown }).meta, (nodeFeedStart as { meta?: unknown }).meta);
    assert.deepEqual((browserFeedStop as { meta?: unknown }).meta, (browserFeedStart as { meta?: unknown }).meta);

    const rabbitFeedStopOptions = rabbitFeedStopCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    await rabbitReplyConsumer?.(
      createMessage(
        { payload: { ok: true } },
        {
          properties: {
            correlationId: rabbitFeedStopOptions.correlationId,
            replyTo: rabbitFeedStopOptions.replyTo,
          },
        },
      ),
    );

    (
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: String(nodeFeedStop.id),
      payload: { ok: true },
    });

    browser.getSocket().emit("message", {
      data: JSON.stringify({
        id: String(browserFeedStop.id),
        payload: { ok: true },
      }),
    });

    const [rabbitStopped, nodeStopped, browserStopped] = await Promise.all([
      rabbitReturn,
      nodeReturn,
      browserReturn,
    ]);

    assert.equal(rabbitStopped.done, true);
    assert.equal(nodeStopped.done, true);
    assert.equal(browserStopped.done, true);
  });

  it("propagates feed error chunks as rejections across all runtimes", async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: "amqp://test" });
    const node = createPatchedWebSocketClient();
    const browser = createPatchedBrowserClient();

    const rabbitIterator = rabbit.feed("users.live", { room: "alpha" })[
      Symbol.asyncIterator
    ]();
    const nodeIterator = node.client.feed("users.live", { room: "alpha" })[
      Symbol.asyncIterator
    ]();
    const browserIterator = browser.client.feed("users.live", { room: "alpha" })[
      Symbol.asyncIterator
    ]();

    const rabbitNext = rabbitIterator.next();
    const nodeNext = nodeIterator.next();
    const browserNext = browserIterator.next();

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    await waitFor(() => node.sentPayloads.length > 0);
    await waitFor(() => browser.sentPayloads.length > 0);

    const rabbitFeedStartCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitFeedStartOptions = rabbitFeedStartCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    const nodeFeedStart = JSON.parse(node.sentPayloads[0]) as { id: string };
    const browserFeedStart = JSON.parse(browser.sentPayloads[0]) as { id: string };

    const rabbitReplyConsumer = rabbitFake.queueConsumers.get("generated-1");
    const feedHash = "feed-error-runtime";
    const feedExchange = `scomp.live.${feedHash}`;

    await rabbitReplyConsumer?.(
      createMessage(
        {
          payload: {
            exchange: feedExchange,
            hash: feedHash,
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
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: nodeFeedStart.id,
      payload: { exchange: feedExchange, hash: feedHash },
    });
    browser.getSocket().emit("message", {
      data: JSON.stringify({
        id: browserFeedStart.id,
        payload: { exchange: feedExchange, hash: feedHash },
      }),
    });

    await waitFor(() => rabbitFake.queueConsumers.has("generated-2"));
    const rabbitFeedConsumer = rabbitFake.queueConsumers.get("generated-2");
    await rabbitFeedConsumer?.(
      createMessage({
        channel: "feed",
        hash: feedHash,
        type: "error",
        message: "runtime feed failure",
      }),
    );
    (
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      channel: "feed",
      hash: feedHash,
      type: "error",
      message: "runtime feed failure",
    });
    browser.getSocket().emit("message", {
      data: JSON.stringify({
        channel: "feed",
        hash: feedHash,
        type: "error",
        message: "runtime feed failure",
      }),
    });

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 1);
    await waitFor(() => node.sentPayloads.length > 1);
    await waitFor(() => browser.sentPayloads.length > 1);

    const rabbitFeedStopCall = rabbitFake.channel.sendToQueue.mock.calls[1];
    const rabbitFeedStopOptions = rabbitFeedStopCall[2] as {
      correlationId: string;
      replyTo: string;
    };
    const nodeFeedStop = JSON.parse(node.sentPayloads[1]) as { id: string };
    const browserFeedStop = JSON.parse(browser.sentPayloads[1]) as { id: string };

    await rabbitReplyConsumer?.(
      createMessage(
        { payload: { ok: true } },
        {
          properties: {
            correlationId: rabbitFeedStopOptions.correlationId,
            replyTo: rabbitFeedStopOptions.replyTo,
          },
        },
      ),
    );
    (
      node.client as unknown as {
        handleIncoming: (message: unknown) => void;
      }
    ).handleIncoming({
      id: nodeFeedStop.id,
      payload: { ok: true },
    });
    browser.getSocket().emit("message", {
      data: JSON.stringify({
        id: browserFeedStop.id,
        payload: { ok: true },
      }),
    });

    await assert.rejects(() => rabbitNext, /runtime feed failure/);
    await assert.rejects(() => nodeNext, /runtime feed failure/);
    await assert.rejects(() => browserNext, /runtime feed failure/);
  });
});
