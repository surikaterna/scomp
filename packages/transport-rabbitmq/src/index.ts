import { randomUUID } from 'node:crypto';
import {
  type CompiledRoute,
  type ITransport
} from '@scomp/core';
import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage
} from 'amqplib';

const SIGNAL_EXCHANGE = 'scomp.signals';

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = 'StreamClosedError';
  }
}

interface RunningFeed {
  key: string;
  exchange: string;
  subscribers: number;
  abortController: AbortController;
}

export interface RabbitMQTransportConfig {
  url: string;
  prefetch?: number;
  serviceName?: string;
}

type RouterTable = Record<string, CompiledRoute>;

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toServiceName(route: string): string {
  const parts = route.split('.');
  return parts[0] ?? 'default';
}

function toRpcQueue(serviceName: string): string {
  return `scomp.rpc.${serviceName}`;
}

function toFeedHash(route: string, payload: unknown, hashKey?: (payload: unknown) => string): string {
  if (hashKey) {
    return hashKey(payload);
  }

  const serialized = JSON.stringify(payload ?? {});
  return Buffer.from(`${route}:${serialized}`).toString('hex').slice(0, 32);
}

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

export class RabbitMQTransport implements ITransport {
  private readonly config: RabbitMQTransportConfig;
  private connection?: ChannelModel;
  private channel?: Channel;
  private router?: RouterTable;
  private replyQueue = '';
  private readonly requestResolvers = new Map<string, (value: any) => void>();
  private readonly requestRejecters = new Map<string, (error: unknown) => void>();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private readonly exchangeToFeedKey = new Map<string, string>();

  constructor(config: RabbitMQTransportConfig) {
    this.config = config;
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, 'topic', { durable: true });

    channel.on('return', (message) => {
      const exchange = message.fields.exchange;
      const feedKey = this.exchangeToFeedKey.get(exchange);
      if (!feedKey) {
        return;
      }

      const runningFeed = this.runningFeeds.get(feedKey);
      if (!runningFeed) {
        return;
      }

      runningFeed.abortController.abort(new StreamClosedError(feedKey));
    });

    const allRoutes = Object.values(router);
    const serviceNames = Array.from(new Set(allRoutes.map((route) => toServiceName(route.route))));

    for (const serviceName of serviceNames) {
      const rpcQueue = toRpcQueue(serviceName);
      await channel.assertQueue(rpcQueue, { durable: true });
      await channel.consume(rpcQueue, async (message) => {
        if (!message) {
          return;
        }

        await this.handleRpcMessage(message);
      });
    }

    const signalRoutes = allRoutes.filter((route) => route.kind === 'signal');
    for (const signalRoute of signalRoutes) {
      const serviceName = toServiceName(signalRoute.route);
      const signalQueue = `scomp.event.${serviceName}.${randomUUID()}`;
      await channel.assertQueue(signalQueue, { exclusive: true, durable: false });
      await channel.bindQueue(signalQueue, SIGNAL_EXCHANGE, signalRoute.route);
      await channel.consume(signalQueue, async (message) => {
        if (!message) {
          return;
        }

        channel.ack(message);
        await this.invokeRoute(signalRoute, message);
      });
    }
  }

  async request(route: string, payload: any): Promise<any> {
    const channel = await this.getChannel();
    await this.ensureReplyConsumer();

    const correlationId = randomUUID();

    const replyPromise = new Promise<any>((resolve, reject) => {
      this.requestResolvers.set(correlationId, resolve);
      this.requestRejecters.set(correlationId, reject);
    });

    const serviceName = toServiceName(route);
    const body = Buffer.from(JSON.stringify({ route, payload, op: 'request' }));

    channel.sendToQueue(toRpcQueue(serviceName), body, {
      correlationId,
      replyTo: this.replyQueue,
      contentType: 'application/json'
    });

    return replyPromise;
  }

  async signal(route: string, payload: any): Promise<void> {
    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, 'topic', { durable: true });

    channel.publish(
      SIGNAL_EXCHANGE,
      route,
      Buffer.from(JSON.stringify({ route, payload })),
      { contentType: 'application/json' }
    );
  }

  feed(route: string, payload: any): AsyncIterable<any> {
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const channel = await self.getChannel();
        const handshake = await self.request(route, {
          op: 'feed_start',
          payload
        });

        const exchangeName = String(handshake.exchange);
        const feedHash = String(handshake.hash);
        const queueName = (await channel.assertQueue('', { exclusive: true, durable: false })).queue;
        await channel.bindQueue(queueName, exchangeName, '');

        const queueBuffer: Array<any> = [];
        const waiters: Array<(value: any) => void> = [];
        let closed = false;

        const { consumerTag } = await channel.consume(queueName, (message) => {
          if (!message) {
            return;
          }

          const parsed = safeJsonParse(message.content.toString('utf8'));
          channel.ack(message);

          if (parsed.type === 'done') {
            closed = true;
          } else if (parsed.type === 'error') {
            closed = true;
            queueBuffer.push(Promise.reject(new Error(parsed.message ?? 'Feed error')));
          } else {
            queueBuffer.push(parsed.payload);
          }

          const waiter = waiters.shift();
          if (waiter) {
            waiter(undefined);
          }
        });

        try {
          while (true) {
            if (queueBuffer.length > 0) {
              const value = queueBuffer.shift();
              if (value instanceof Promise) {
                await value;
              }
              if (closed && value === undefined) {
                return;
              }
              if (value !== undefined) {
                yield value;
              }
            } else if (closed) {
              return;
            } else {
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          }
        } finally {
          await channel.cancel(consumerTag);
          await channel.unbindQueue(queueName, exchangeName, '');
          await channel.deleteQueue(queueName);
          await self.request(route, {
            op: 'feed_stop',
            payload,
            hash: feedHash
          });
        }
      }
    };
  }

  private async getConnection(): Promise<ChannelModel> {
    if (!this.connection) {
      this.connection = await amqp.connect(this.config.url);
    }
    return this.connection;
  }

  private async getChannel(): Promise<Channel> {
    if (!this.channel) {
      const connection = await this.getConnection();
      this.channel = await connection.createChannel();
      const channel = this.channel;
      if (this.config.prefetch && channel) {
        await channel.prefetch(this.config.prefetch);
      }
    }

    const channel = this.channel;
    if (!channel) {
      throw new Error('RabbitMQ channel is not initialized.');
    }

    return channel;
  }

  private async ensureReplyConsumer(): Promise<void> {
    if (this.replyQueue) {
      return;
    }

    const channel = await this.getChannel();
    const asserted = await channel.assertQueue('', { exclusive: true, durable: false, autoDelete: true });
    this.replyQueue = asserted.queue;

    await channel.consume(this.replyQueue, (message) => {
      if (!message) {
        return;
      }

      const correlationId = message.properties.correlationId;
      const resolve = this.requestResolvers.get(correlationId);
      const reject = this.requestRejecters.get(correlationId);

      this.requestResolvers.delete(correlationId);
      this.requestRejecters.delete(correlationId);

      const body = safeJsonParse(message.content.toString('utf8'));
      if (body.error) {
        reject?.(new Error(String(body.error)));
      } else {
        resolve?.(body.payload);
      }

      channel.ack(message);
    });
  }

  private async handleRpcMessage(message: ConsumeMessage): Promise<void> {
    const channel = await this.getChannel();
    const body = safeJsonParse(message.content.toString('utf8'));
    const route = String(body.route ?? '');
    const routeEntry = this.router?.[route];

    if (!routeEntry) {
      channel.ack(message);
      this.replyWithError(message, `Route not found: ${route}`);
      return;
    }

    if (routeEntry.kind === 'feed') {
      await this.handleFeedRpc(routeEntry, message, body);
      channel.ack(message);
      return;
    }

    try {
      const output = await this.invokeRoute(routeEntry, message);
      this.replyWithPayload(message, output);
    } catch (error) {
      this.replyWithError(message, error);
    } finally {
      channel.ack(message);
    }
  }

  private async handleFeedRpc(route: CompiledRoute, message: ConsumeMessage, body: any): Promise<void> {
    const op = String(body.payload?.op ?? body.op ?? 'request');
    const rawPayload = body.payload?.payload ?? body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const hash = String(body.payload?.hash ?? toFeedHash(route.route, parsedPayload, route.hashKey));

    if (op === 'feed_stop') {
      const running = this.runningFeeds.get(hash);
      if (running) {
        running.subscribers = Math.max(0, running.subscribers - 1);
      }
      this.replyWithPayload(message, { ok: true });
      return;
    }

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers += 1;
      this.replyWithPayload(message, { exchange: existing.exchange, hash });
      return;
    }

    const exchange = toFeedExchange(hash);
    const channel = await this.getChannel();
    await channel.assertExchange(exchange, 'fanout', {
      durable: false,
      autoDelete: true
    });

    const runningFeed: RunningFeed = {
      key: hash,
      exchange,
      subscribers: 1,
      abortController: new AbortController()
    };
    this.runningFeeds.set(hash, runningFeed);
    this.exchangeToFeedKey.set(exchange, hash);

    const iterable = route.handler(parsedPayload) as AsyncIterable<any>;
    void this.publishFeed(route, runningFeed, iterable);

    this.replyWithPayload(message, { exchange, hash });
  }

  private async publishFeed(route: CompiledRoute, runningFeed: RunningFeed, iterable: AsyncIterable<any>): Promise<void> {
    const channel = await this.getChannel();

    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        channel.publish(
          runningFeed.exchange,
          '',
          Buffer.from(JSON.stringify({ type: 'next', payload: chunk })),
          {
            contentType: 'application/json',
            mandatory: true
          }
        );
      }

      channel.publish(
        runningFeed.exchange,
        '',
        Buffer.from(JSON.stringify({ type: 'done' })),
        {
          contentType: 'application/json',
          mandatory: true
        }
      );
    } catch (error) {
      channel.publish(
        runningFeed.exchange,
        '',
        Buffer.from(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })),
        {
          contentType: 'application/json',
          mandatory: true
        }
      );
    } finally {
      this.runningFeeds.delete(runningFeed.key);
      this.exchangeToFeedKey.delete(runningFeed.exchange);
    }
  }

  private async invokeRoute(route: CompiledRoute, message: ConsumeMessage): Promise<any> {
    const body = safeJsonParse(message.content.toString('utf8'));
    const rawPayload = body.payload?.payload ?? body.payload;
    const payload = route.parser ? route.parser(rawPayload) : rawPayload;
    return route.handler(payload);
  }

  private replyWithPayload(message: ConsumeMessage, payload: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(replyTo, Buffer.from(JSON.stringify({ payload })), {
      correlationId: message.properties.correlationId,
      contentType: 'application/json'
    });
  }

  private replyWithError(message: ConsumeMessage, error: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(
      replyTo,
      Buffer.from(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })),
      {
        correlationId: message.properties.correlationId,
        contentType: 'application/json'
      }
    );
  }
}

export function createRabbitMqTransport(config: RabbitMQTransportConfig): RabbitMQTransport {
  return new RabbitMQTransport(config);
}
