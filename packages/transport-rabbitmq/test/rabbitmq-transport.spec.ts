import assert from 'node:assert/strict';
import { createJsonSerializer, RabbitMQTransport, StreamClosedError } from '../src';

const mockConnect = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock('node:crypto', () => ({
  randomUUID: (...args: Array<unknown>) => mockRandomUUID(...args)
}));

jest.mock('amqplib', () => ({
  __esModule: true,
  default: {
    connect: (...args: Array<unknown>) => mockConnect(...args)
  },
  connect: (...args: Array<unknown>) => mockConnect(...args)
}));

type QueueConsumer = (message: any) => void | Promise<void>;

function createFakeChannel() {
  const queueConsumers = new Map<string, QueueConsumer>();
  const eventHandlers = new Map<string, (message: any) => void>();
  let generatedQueueCounter = 0;

  const channel = {
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn(async (name: string, _opts?: unknown) => {
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
    on: jest.fn((eventName: string, handler: (message: any) => void) => {
      eventHandlers.set(eventName, handler);
      return channel;
    })
  };

  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel)
  };

  return {
    channel,
    connection,
    queueConsumers,
    eventHandlers
  };
}

function createMessage(payload: unknown, overrides: Partial<any> = {}) {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    properties: {
      correlationId: overrides.properties?.correlationId ?? 'corr-default',
      replyTo: overrides.properties?.replyTo ?? 'reply-queue'
    },
    fields: {
      exchange: overrides.fields?.exchange ?? ''
    },
    ...overrides
  };
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error('Timed out waiting for condition.');
}

describe('RabbitMQTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let idCounter = 0;
    mockRandomUUID.mockImplementation(() => {
      idCounter += 1;
      return `id-${idCounter}`;
    });
  });

  it('initializes connection/channel and applies prefetch once', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({ url: 'amqp://test', prefetch: 10 });
    await transport.signal('users.notify', { id: 1 });
    await transport.signal('users.notify', { id: 2 });

    assert.equal(mockConnect.mock.calls.length, 1);
    assert.equal(fake.connection.createChannel.mock.calls.length, 1);
    assert.equal(fake.channel.prefetch.mock.calls.length, 1);
    assert.equal(fake.channel.prefetch.mock.calls[0][0], 10);
  });

  it('request() publishes RPC message and resolves from reply queue callback', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({ url: 'amqp://test' });
    const pending = transport.request('users.getUser', { id: 7 });
    await waitFor(() => fake.channel.consume.mock.calls.length > 0);
    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);

    assert.equal(fake.channel.sendToQueue.mock.calls.length, 1);
    const [rpcQueue, rpcBody, rpcOptions] = fake.channel.sendToQueue.mock.calls[0];
    assert.equal(rpcQueue, 'scomp.rpc.users');
    assert.equal(rpcOptions.replyTo, 'generated-1');
    assert.equal(rpcOptions.correlationId, 'id-1');
    assert.equal(rpcOptions.contentType, 'application/json');

    const decoded = JSON.parse(Buffer.from(rpcBody).toString('utf8'));
    assert.equal(decoded.route, 'users.getUser');
    assert.deepEqual(decoded.payload, { id: 7 });

    const replyConsumer = fake.queueConsumers.get('generated-1');
    assert.equal(typeof replyConsumer, 'function');

    await replyConsumer?.(createMessage({ payload: { id: 7, name: 'u-7' } }, {
      properties: {
        correlationId: 'id-1',
        replyTo: 'generated-1'
      }
    }));

    const resolved = await pending;
    assert.deepEqual(resolved, { id: 7, name: 'u-7' });
    assert.equal(fake.channel.ack.mock.calls.length, 1);
  });

  it('signal() publishes payload to topic exchange', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({ url: 'amqp://test' });
    await transport.signal('users.notifyLogin', { id: 5 });

    assert.equal(fake.channel.assertExchange.mock.calls.length >= 1, true);
    assert.equal(fake.channel.publish.mock.calls.length, 1);
    const [exchange, routingKey, content, options] = fake.channel.publish.mock.calls[0];
    assert.equal(exchange, 'scomp.signals');
    assert.equal(routingKey, 'users.notifyLogin');
    assert.equal(options.contentType, 'application/json');
    assert.deepEqual(JSON.parse(Buffer.from(content).toString('utf8')), {
      route: 'users.notifyLogin',
      op: 'signal',
      payload: { id: 5 }
    });
  });

  it('supports pluggable serializer for BigInt and Date payloads', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const serializer = createJsonSerializer({
      contentType: 'application/x-scomp-json+v1',
      replacer: (_key, value) => {
        if (typeof value === 'bigint') {
          return { __type: 'bigint', value: value.toString() };
        }

        if (value instanceof Date) {
          return { __type: 'date', value: value.toISOString() };
        }

        return value;
      },
      reviver: (_key, value) => {
        if (value && typeof value === 'object' && (value as any).__type === 'bigint') {
          return BigInt((value as any).value);
        }

        if (value && typeof value === 'object' && (value as any).__type === 'date') {
          return new Date((value as any).value);
        }

        return value;
      }
    });

    const transport = new RabbitMQTransport({
      url: 'amqp://test',
      serializer
    });

    const payloadDate = new Date('2025-01-02T03:04:05.000Z');
    const requestPromise = transport.request('users.getUser', {
      id: 1n,
      at: payloadDate
    });

    await waitFor(() => fake.channel.sendToQueue.mock.calls.length > 0);
    const [, requestBody, requestOptions] = fake.channel.sendToQueue.mock.calls[0];
    assert.equal(requestOptions.contentType, 'application/x-scomp-json+v1');

    const requestParsed = JSON.parse(Buffer.from(requestBody).toString('utf8'));
    assert.deepEqual(requestParsed.payload.id, { __type: 'bigint', value: '1' });

    const replyConsumer = fake.queueConsumers.get('generated-1');
    await replyConsumer?.(createMessage({
      payload: {
        id: { __type: 'bigint', value: '9' },
        at: { __type: 'date', value: payloadDate.toISOString() }
      }
    }, {
      properties: { correlationId: 'id-1', replyTo: 'generated-1' }
    }));

    const response = await requestPromise;
    assert.equal(typeof response.id, 'bigint');
    assert.equal(response.id, 9n);
    assert.equal(response.at instanceof Date, true);
  });

  it('listen() binds request and signal consumers and acks signals immediately', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const signalCalls: Array<unknown> = [];
    const router = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async (payload: any) => ({ ok: true, payload })
      },
      'users.notifyLogin': {
        route: 'users.notifyLogin',
        kind: 'signal',
        handler: async (payload: any) => {
          signalCalls.push(payload);
        }
      }
    } as any;

    const transport = new RabbitMQTransport({ url: 'amqp://test' });
    await transport.listen(router);

    assert.equal(fake.channel.assertQueue.mock.calls.some((call: Array<any>) => call[0] === 'scomp.rpc.users'), true);

    const signalQueueCall = fake.channel.assertQueue.mock.calls.find((call: Array<any>) => String(call[0]).startsWith('scomp.event.users.'));
    assert.equal(Boolean(signalQueueCall), true);

    const signalQueueName = signalQueueCall?.[0];
    const signalConsumer = fake.queueConsumers.get(signalQueueName);
    const msg = createMessage({ route: 'users.notifyLogin', payload: { id: 9 } });

    await signalConsumer?.(msg);

    assert.equal(fake.channel.ack.mock.calls.length, 1);
    assert.deepEqual(signalCalls, [{ id: 9 }]);
  });

  it('feed() performs handshake, streams messages, and requests stop on unsubscribe', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const transport = new RabbitMQTransport({ url: 'amqp://test' });
    const requestSpy = jest
      .spyOn(transport, 'request')
      .mockResolvedValueOnce({ exchange: 'scomp.live.room1', hash: 'room1' })
      .mockResolvedValueOnce({ ok: true });

    const iterator = transport.feed('users.liveTicker', { room: 'room1' })[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushMicrotasks();
    await waitFor(() => fake.queueConsumers.size > 0);

    const actualStreamConsumer = fake.queueConsumers.get('generated-1');
    assert.equal(typeof actualStreamConsumer, 'function');

    await actualStreamConsumer?.(createMessage({ type: 'next', payload: { seq: 1 } }));
    const first = await nextPromise;
    assert.deepEqual(first, { value: { seq: 1 }, done: false });

    await iterator.return?.(undefined);

    assert.equal(fake.channel.cancel.mock.calls.length, 1);
    assert.equal(fake.channel.deleteQueue.mock.calls.length, 1);
    assert.equal(requestSpy.mock.calls.length, 2);
    assert.equal(requestSpy.mock.calls[1][0], 'users.liveTicker');
    assert.equal(requestSpy.mock.calls[1][1].op, 'feed_stop');
    assert.deepEqual(requestSpy.mock.calls[1][1].payload, { room: 'room1' });
    assert.equal(requestSpy.mock.calls[1][1].hash, 'room1');
  });

  it('aborts running fanout feed when channel emits basic.return', async () => {
    const fake = createFakeChannel();
    mockConnect.mockResolvedValue(fake.connection);

    const route = {
      route: 'users.liveTicker',
      kind: 'feed',
      strategy: 'fanout',
      hashKey: () => 'room-x',
      handler: async function* () {
        await new Promise<void>(() => {
          return;
        });
        yield { seq: 1 };
      }
    };

    const transport = new RabbitMQTransport({ url: 'amqp://test' });
    await transport.listen({ 'users.liveTicker': route } as any);

    const rpcConsumer = fake.queueConsumers.get('scomp.rpc.users');
    assert.equal(typeof rpcConsumer, 'function');

    await rpcConsumer?.(createMessage({
      route: 'users.liveTicker',
      payload: {
        op: 'feed_start',
        payload: { room: 'room-x' }
      }
    }));

    const running = (transport as any).runningFeeds.get('room-x');
    assert.equal(Boolean(running), true);

    const returnHandler = fake.eventHandlers.get('return');
    returnHandler?.({ fields: { exchange: 'scomp.live.room-x' } });

    assert.equal(running.abortController.signal.aborted, true);
    assert.equal(running.abortController.signal.reason instanceof StreamClosedError, true);
  });
});
