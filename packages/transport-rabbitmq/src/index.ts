import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  type CompiledRoute,
  type ITransport
} from '@scomp/core';
import type {
  ScompFeedChunk,
  ScompSerializer,
  ScompTransportRequest,
  ScompTransportResponse
} from '@scomp/types';
import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage
} from 'amqplib';
import { defaultJsonSerializer } from './serialization';

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

export interface RabbitMQTransportRetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RabbitMQTransportSecurityContext {
  direction: 'inbound' | 'outbound';
  route: string;
  operation: string;
  payload: unknown;
}

export interface RabbitMQTransportSecurityConfig {
  requireTls?: boolean;
  maxPayloadBytes?: number;
  authorize?: (ctx: RabbitMQTransportSecurityContext) => boolean | Promise<boolean>;
}

export interface RabbitMQTransportPerformanceConfig {
  requestTimeoutMs?: number;
  maxInFlightRequests?: number;
  feedBufferHighWaterMark?: number;
}

export type RabbitMQTransportEvent =
  | { type: 'connection_opened' }
  | { type: 'connection_reconnect'; attempt: number }
  | { type: 'connection_closed'; reason?: string }
  | { type: 'channel_opened' }
  | { type: 'request_sent'; route: string; correlationId: string }
  | { type: 'request_resolved'; route: string; correlationId: string; durationMs: number }
  | { type: 'request_rejected'; route: string; correlationId: string; reason: string }
  | { type: 'request_timeout'; route: string; correlationId: string; timeoutMs: number }
  | { type: 'signal_sent'; route: string }
  | { type: 'feed_started'; route: string; hash: string }
  | { type: 'feed_joined'; route: string; hash: string }
  | { type: 'feed_stopped'; route: string; hash: string }
  | { type: 'feed_aborted'; hash: string }
  | { type: 'publish_return'; exchange: string }
  | { type: 'security_denied'; route: string; operation: string; direction: 'inbound' | 'outbound' };

export interface RabbitMQTransportObservabilityConfig {
  onEvent?: (event: RabbitMQTransportEvent) => void;
  now?: () => number;
}

export interface RabbitMQTransportConfig {
  url: string;
  prefetch?: number;
  serviceName?: string;
  serializer?: ScompSerializer;
  retry?: RabbitMQTransportRetryConfig;
  security?: RabbitMQTransportSecurityConfig;
  performance?: RabbitMQTransportPerformanceConfig;
  observability?: RabbitMQTransportObservabilityConfig;
}

type RouterTable = Record<string, CompiledRoute>;

function toServiceName(route: string): string {
  const parts = route.split('.');
  return parts[0] ?? 'default';
}

function toRpcQueue(serviceName: string): string {
  return `scomp.rpc.${serviceName}`;
}

function toFeedHash(
  route: string,
  payload: unknown,
  hashKey: ((payload: unknown) => string) | undefined,
  serialize: (value: unknown) => string
): string {
  if (hashKey) {
    return hashKey(payload);
  }

  const serialized = serialize(payload ?? {});
  return Buffer.from(`${route}:${serialized}`).toString('hex').slice(0, 32);
}

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

export class RabbitMQTransport implements ITransport {
  private readonly config: RabbitMQTransportConfig;
  private readonly serializer: ScompSerializer;
  private readonly contentType: string;
  private connection?: ChannelModel;
  private channel?: Channel;
  private router?: RouterTable;
  private replyQueue = '';
  private readonly requestStartTime = new Map<string, number>();
  private readonly requestResolvers = new Map<string, (value: unknown) => void>();
  private readonly requestRejecters = new Map<string, (error: unknown) => void>();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private readonly exchangeToFeedKey = new Map<string, string>();
  private readonly serializer: ScompSerializer;
  private readonly contentType: string;

  constructor(config: RabbitMQTransportConfig) {
    this.config = config;
    this.serializer = config.serializer ?? defaultJsonSerializer;
    this.contentType = this.serializer.contentType ?? 'application/json';

    if (config.security?.requireTls && !config.url.startsWith('amqps://')) {
      throw new Error('RabbitMQTransport requires TLS but URL is not amqps://');
    }
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, 'topic', { durable: true });

    channel.on('return', (message) => {
      const exchange = message.fields.exchange;
      this.emitEvent({ type: 'publish_return', exchange });
      const feedKey = this.exchangeToFeedKey.get(exchange);
      if (!feedKey) {
        return;
      }

      const runningFeed = this.runningFeeds.get(feedKey);
      if (!runningFeed) {
        return;
      }

      this.emitEvent({ type: 'feed_aborted', hash: feedKey });
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

        const body = this.deserializeFromBuffer<ScompTransportRequest>(message.content);
        const allowed = await this.authorize({
          direction: 'inbound',
          route: signalRoute.route,
          operation: 'signal',
          payload: body.payload
        });
        if (!allowed) {
          channel.ack(message);
          this.emitEvent({
            type: 'security_denied',
            route: signalRoute.route,
            operation: 'signal',
            direction: 'inbound'
          });
          return;
        }

        channel.ack(message);
        await this.invokeRoute(signalRoute, message);
      });
    }
  }

  async request(route: string, payload: unknown): Promise<unknown> {
    const allowed = await this.authorize({ direction: 'outbound', route, operation: 'request', payload });
    if (!allowed) {
      this.emitEvent({ type: 'security_denied', route, operation: 'request', direction: 'outbound' });
      throw new Error(`Request not authorized for route: ${route}`);
    }

    if (this.requestResolvers.size >= this.getMaxInFlightRequests()) {
      throw new Error(`In-flight request limit reached: ${this.getMaxInFlightRequests()}`);
    }

    const channel = await this.getChannel();
    await this.ensureReplyConsumer();

    const correlationId = randomUUID();
    this.requestStartTime.set(correlationId, this.now());

    const replyPromise = new Promise<unknown>((resolve, reject) => {
      this.requestResolvers.set(correlationId, resolve);
      this.requestRejecters.set(correlationId, reject);
    });

    const serviceName = toServiceName(route);
    const body = this.serializeToBuffer({
      route,
      payload,
      op: 'request'
    } satisfies ScompTransportRequest);

    channel.sendToQueue(toRpcQueue(serviceName), body, {
      correlationId,
      replyTo: this.replyQueue,
      contentType: this.contentType
    });

    this.emitEvent({ type: 'request_sent', route, correlationId });

    const timeoutMs = this.getRequestTimeoutMs();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestResolvers.delete(correlationId);
        this.requestRejecters.delete(correlationId);
        this.requestStartTime.delete(correlationId);
        this.emitEvent({ type: 'request_timeout', route, correlationId, timeoutMs });
        reject(new Error(`Request timed out after ${timeoutMs}ms for route: ${route}`));
      }, timeoutMs);

      void replyPromise.finally(() => clearTimeout(timer));
    });

    return Promise.race([replyPromise, timeoutPromise]);
  }

  async signal(route: string, payload: unknown): Promise<void> {
    const allowed = await this.authorize({ direction: 'outbound', route, operation: 'signal', payload });
    if (!allowed) {
      this.emitEvent({ type: 'security_denied', route, operation: 'signal', direction: 'outbound' });
      throw new Error(`Signal not authorized for route: ${route}`);
    }

    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, 'topic', { durable: true });

    const content = this.serializeToBuffer({ route, payload, op: 'signal' });
    this.assertPayloadSize(content);
    channel.publish(
      SIGNAL_EXCHANGE,
      route,
      this.serializeToBuffer({ route, payload, op: 'signal' } satisfies ScompTransportRequest),
      { contentType: this.contentType }
    );

    this.emitEvent({ type: 'signal_sent', route });
  }

  feed(route: string, payload: unknown): AsyncIterable<unknown> {
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const channel = await self.getChannel();
        const allowed = await self.authorize({ direction: 'outbound', route, operation: 'feed_start', payload });
        if (!allowed) {
          self.emitEvent({ type: 'security_denied', route, operation: 'feed_start', direction: 'outbound' });
          throw new Error(`Feed start not authorized for route: ${route}`);
        }

        const handshake = await self.request(route, {
          op: 'feed_start',
          payload
        }) as { exchange: string; hash: string };

        const exchangeName = String(handshake.exchange);
        const feedHash = String(handshake.hash);
        const queueName = (await channel.assertQueue('', { exclusive: true, durable: false })).queue;
        await channel.bindQueue(queueName, exchangeName, '');

        const queueBuffer: Array<unknown> = [];
        const waiters: Array<() => void> = [];
        let closed = false;
        const feedBufferLimit = self.getFeedBufferLimit();

        const { consumerTag } = await channel.consume(queueName, (message) => {
          if (!message) {
            return;
          }

          const parsed = self.deserializeFromBuffer<ScompFeedChunk>(message.content);
          channel.ack(message);

          if (parsed.type === 'done') {
            closed = true;
          } else if (parsed.type === 'error') {
            closed = true;
            queueBuffer.push(Promise.reject(new Error(parsed.message ?? 'Feed error')));
          } else {
            if (queueBuffer.length >= feedBufferLimit) {
              closed = true;
              queueBuffer.push(Promise.reject(new Error(`Feed buffer high-water mark exceeded (${feedBufferLimit})`)));
              return;
            }
            queueBuffer.push(parsed.payload);
          }

          waiters.shift()?.();
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
          self.emitEvent({ type: 'feed_stopped', route, hash: feedHash });
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
      this.connection = await this.connectWithRetry();
      this.emitEvent({ type: 'connection_opened' });
      this.connection.on('close', () => {
        this.connection = undefined;
        this.channel = undefined;
        this.emitEvent({ type: 'connection_closed' });
      });
      this.connection.on('error', (error) => {
        this.emitEvent({ type: 'connection_closed', reason: error instanceof Error ? error.message : String(error) });
      });
    }
    return this.connection;
  }

  private async getChannel(): Promise<Channel> {
    if (!this.channel) {
      const connection = await this.getConnection();
      this.channel = await connection.createChannel();
      this.emitEvent({ type: 'channel_opened' });
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

      const body = this.deserializeFromBuffer<ScompTransportResponse>(message.content);
      if ('error' in body) {
        reject?.(new Error(String(body.error)));
      } else {
        const startedAt = this.requestStartTime.get(correlationId) ?? this.now();
        this.emitEvent({
          type: 'request_resolved',
          route: 'unknown',
          correlationId,
          durationMs: this.now() - startedAt
        });
        resolve?.(body.payload);
      }
      this.requestStartTime.delete(correlationId);

      channel.ack(message);
    });
  }

  private async handleRpcMessage(message: ConsumeMessage): Promise<void> {
    const channel = await this.getChannel();
    const body = this.deserializeFromBuffer<ScompTransportRequest>(message.content);
    const route = String(body.route ?? '');
    const allowed = await this.authorize({
      direction: 'inbound',
      route,
      operation: String(body.op ?? 'request'),
      payload: body.payload
    });
    if (!allowed) {
      channel.ack(message);
      this.emitEvent({ type: 'security_denied', route, operation: String(body.op ?? 'request'), direction: 'inbound' });
      this.replyWithError(message, `Inbound operation not authorized for route: ${route}`);
      return;
    }

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

  private async handleFeedRpc(route: CompiledRoute, message: ConsumeMessage, body: ScompTransportRequest): Promise<void> {
    const payloadEnvelope = body.payload as Record<string, unknown> | undefined;
    const op = String(payloadEnvelope?.op ?? body.op ?? 'request');
    const rawPayload = payloadEnvelope && 'payload' in payloadEnvelope
      ? payloadEnvelope.payload
      : body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const hash = String(
      body.payload?.hash
      ?? toFeedHash(route.route, parsedPayload, route.hashKey, (value) => this.serializer.stringify(value))
    );

    if (op === 'feed_stop') {
      const running = this.runningFeeds.get(hash);
      if (running) {
        running.subscribers = Math.max(0, running.subscribers - 1);
      }
      this.emitEvent({ type: 'feed_stopped', route: route.route, hash });
      this.replyWithPayload(message, { ok: true });
      return;
    }

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers += 1;
      this.emitEvent({ type: 'feed_joined', route: route.route, hash });
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
    this.emitEvent({ type: 'feed_started', route: route.route, hash });

    const iterable = route.handler(parsedPayload) as AsyncIterable<unknown>;
    void this.publishFeed(route, runningFeed, iterable);

    this.replyWithPayload(message, { exchange, hash });
  }

  private async publishFeed(route: CompiledRoute, runningFeed: RunningFeed, iterable: AsyncIterable<unknown>): Promise<void> {
    const channel = await this.getChannel();

    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        channel.publish(
          runningFeed.exchange,
          '',
          this.serializeToBuffer({ type: 'next', payload: chunk } satisfies ScompFeedChunk),
          {
            contentType: this.contentType,
            mandatory: true
          }
        );
        await this.waitForChannelDrainIfNeeded(channel);
      }

      channel.publish(
        runningFeed.exchange,
        '',
        this.serializeToBuffer({ type: 'done' } satisfies ScompFeedChunk),
        {
          contentType: this.contentType,
          mandatory: true
        }
      );
      await this.waitForChannelDrainIfNeeded(channel);
    } catch (error) {
      channel.publish(
        runningFeed.exchange,
        '',
        this.serializeToBuffer({
          type: 'error',
          message: error instanceof Error ? error.message : String(error)
        } satisfies ScompFeedChunk),
        {
          contentType: this.contentType,
          mandatory: true
        }
      );
      await this.waitForChannelDrainIfNeeded(channel);
    } finally {
      this.runningFeeds.delete(runningFeed.key);
      this.exchangeToFeedKey.delete(runningFeed.exchange);
    }
  }

  private async invokeRoute(route: CompiledRoute, message: ConsumeMessage): Promise<any> {
    const body = this.deserializeFromBuffer<ScompTransportRequest>(message.content);
    const payloadEnvelope = body.payload as Record<string, unknown> | undefined;
    const rawPayload = payloadEnvelope && 'payload' in payloadEnvelope
      ? payloadEnvelope.payload
      : body.payload;
    const payload = route.parser ? route.parser(rawPayload) : rawPayload;
    return route.handler(payload);
  }

  private replyWithPayload(message: ConsumeMessage, payload: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(replyTo, this.serializeToBuffer({ payload } satisfies ScompTransportResponse), {
      correlationId: message.properties.correlationId,
      contentType: this.contentType
    });
  }

  private replyWithError(message: ConsumeMessage, error: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(
      replyTo,
      this.serializeToBuffer({
        error: error instanceof Error ? error.message : String(error)
      } satisfies ScompTransportResponse),
      {
        correlationId: message.properties.correlationId,
        contentType: this.contentType
      }
    );
  }

  private serializeToBuffer(value: unknown): Buffer {
    return Buffer.from(this.serializer.stringify(value));
  }

  private deserializeFromBuffer<T = unknown>(value: Buffer): T {
    return this.serializer.parse<T>(value.toString('utf8'));
  }
}

export function createRabbitMqTransport(config: RabbitMQTransportConfig): RabbitMQTransport {
  return new RabbitMQTransport(config);
}

export {
  createJsonSerializer,
  defaultJsonSerializer,
  type ExtendedJsonSerializerOptions
} from './serialization';
