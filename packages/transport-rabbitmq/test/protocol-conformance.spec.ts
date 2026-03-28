import assert from 'node:assert/strict';
import { RabbitMQTransport } from '../src';
import { WebSocketClientTransport } from '../../transport-websocket-client/src';

const mockConnect = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return {
    ...actual,
    randomUUID: (...args: Array<unknown>) => mockRandomUUID(...args)
  };
});

type QueueConsumer = (message: unknown) => void | Promise<void>;

jest.mock('amqplib', () => ({
  __esModule: true,
  default: {
    connect: (...args: Array<unknown>) => mockConnect(...args)
  },
  connect: (...args: Array<unknown>) => mockConnect(...args)
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
      correlationId: overrides.properties?.correlationId ?? 'corr-default',
      replyTo: overrides.properties?.replyTo ?? 'reply-queue'
    },
    ...overrides
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
    on: jest.fn()
  };

  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn()
  };

  return {
    channel,
    connection,
    queueConsumers
  };
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error('Timed out waiting for condition.');
}

function stripId(payload: Record<string, unknown>) {
  const clone = { ...payload };
  delete clone.id;
  return clone;
}

function createPatchedWebSocketClient() {
  const client = new WebSocketClientTransport({ url: 'ws://placeholder' });
  const sentPayloads: Array<string> = [];

  (client as unknown as { getSocket: () => Promise<{ send: (payload: string) => void }> }).getSocket = async () => ({
    send: (payload: string) => {
      sentPayloads.push(payload);
    }
  });

  return { client, sentPayloads };
}

describe('Protocol conformance across websocket and rabbitmq', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let idCounter = 0;
    mockRandomUUID.mockImplementation(() => {
      idCounter += 1;
      return `id-${idCounter}`;
    });
  });

  it('encodes identical signal envelope shape', async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: 'amqp://test' });
    const websocket = createPatchedWebSocketClient();

    await Promise.all([
      rabbit.signal('users.notify', { id: 7 }),
      websocket.client.signal('users.notify', { id: 7 })
    ]);

    const rabbitPublishCall = rabbitFake.channel.publish.mock.calls[0];
    const rabbitEnvelope = JSON.parse(Buffer.from(rabbitPublishCall[2]).toString('utf8'));
    const websocketEnvelope = JSON.parse(websocket.sentPayloads[0]);

    assert.deepEqual(websocketEnvelope, rabbitEnvelope);
  });

  it('encodes request envelopes with equivalent shape after transport metadata normalization', async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: 'amqp://test' });
    const websocket = createPatchedWebSocketClient();

    const rabbitPending = rabbit.request('users.get', { id: 9 });
    const websocketPending = websocket.client.request('users.get', { id: 9 });

    await waitFor(() => rabbitFake.channel.sendToQueue.mock.calls.length > 0);
    const rabbitRequestCall = rabbitFake.channel.sendToQueue.mock.calls[0];
    const rabbitRequest = JSON.parse(Buffer.from(rabbitRequestCall[1]).toString('utf8')) as Record<string, unknown>;
    const rabbitRequestOptions = rabbitRequestCall[2] as { correlationId: string; replyTo: string };

    await waitFor(() => websocket.sentPayloads.length > 0);
    const websocketRequest = JSON.parse(websocket.sentPayloads[0]) as Record<string, unknown>;

    assert.deepEqual(stripId(websocketRequest), rabbitRequest);

    const websocketRequestId = String(websocketRequest.id);
    (websocket.client as unknown as { handleIncoming: (message: unknown) => void }).handleIncoming({
      id: websocketRequestId,
      payload: { ok: true }
    });

    const rabbitReplyConsumer = rabbitFake.queueConsumers.get('generated-1');
    await rabbitReplyConsumer?.(createMessage({ payload: { ok: true } }, {
      properties: {
        correlationId: rabbitRequestOptions.correlationId,
        replyTo: rabbitRequestOptions.replyTo
      }
    }));

    assert.deepEqual(await websocketPending, { ok: true });
    assert.deepEqual(await rabbitPending, { ok: true });
  });

  it('produces rabbit feed chunks that websocket feed decoder accepts', async () => {
    const rabbitFake = createFakeChannel();
    mockConnect.mockResolvedValue(rabbitFake.connection);

    const rabbit = new RabbitMQTransport({ url: 'amqp://test' });
    await rabbit.listen({
      'users.live': {
        route: 'users.live',
        kind: 'feed',
        strategy: 'fanout',
        handler: async function* () {
          yield { seq: 1 };
        }
      }
    } as unknown as Record<string, unknown>);

    const rpcConsumer = rabbitFake.queueConsumers.get('scomp.rpc.users');
    await rpcConsumer?.(createMessage({ route: 'users.live', op: 'feed_start', payload: { room: 'alpha' } }));

    await waitFor(() => rabbitFake.channel.publish.mock.calls.length >= 2);

    const firstChunk = JSON.parse(Buffer.from(rabbitFake.channel.publish.mock.calls[0][2]).toString('utf8'));
    assert.equal(firstChunk.channel, 'feed');
    assert.equal(firstChunk.type, 'next');
    assert.equal(typeof firstChunk.hash, 'string');

    const websocket = createPatchedWebSocketClient().client as unknown as {
      feeds: Map<string, unknown>;
      handleIncoming: (message: unknown) => void;
    };

    const feedState = {
      queue: [] as Array<unknown | Promise<never>>,
      waiters: [] as Array<() => void>,
      closed: false
    };

    websocket.feeds.set(firstChunk.hash, feedState);
    websocket.handleIncoming(firstChunk);
    assert.deepEqual(feedState.queue[0], { seq: 1 });

    const doneChunk = JSON.parse(Buffer.from(rabbitFake.channel.publish.mock.calls[1][2]).toString('utf8'));
    websocket.handleIncoming(doneChunk);
    assert.equal(feedState.closed, true);
  });
});
