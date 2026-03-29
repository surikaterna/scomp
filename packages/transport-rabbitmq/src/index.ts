import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  type CompiledRoute,
  type ITransport,
  type ScompClientInvokeOptions,
} from "@scomp/core";
import {
  createFeedHash,
  type ScompFeedChunkEnvelope,
  type ScompTransportMessageMeta,
  type ScompTransportPrincipal,
  type ScompTransportSecurityContext,
  type ScompTransportSecurityPolicy,
  type ScompSerializer,
  type ScompTransportRequestEnvelope,
  type ScompTransportResponseEnvelope,
} from "@scomp/types";
import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from "amqplib";
import { defaultJsonSerializer } from "./serialization";

const SIGNAL_EXCHANGE = "scomp.signals";

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = "StreamClosedError";
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

export interface RabbitMQTransportSecurityConfig {
  requireTls?: boolean;
  maxPayloadBytes?: number;
  policy?: ScompTransportSecurityPolicy;
  authorize?: (ctx: {
    direction: "inbound" | "outbound";
    route: string;
    operation: string;
    payload: unknown;
  }) => boolean | Promise<boolean>;
}

export interface RabbitMQTransportPerformanceConfig {
  requestTimeoutMs?: number;
  maxInFlightRequests?: number;
  feedBufferHighWaterMark?: number;
}

export type RabbitMQTransportEvent =
  | { type: "connection_opened" }
  | { type: "connection_reconnect"; attempt: number }
  | { type: "connection_closed"; reason?: string }
  | { type: "channel_opened" }
  | { type: "request_sent"; route: string; correlationId: string }
  | {
      type: "request_resolved";
      route: string;
      correlationId: string;
      durationMs: number;
    }
  | {
      type: "request_rejected";
      route: string;
      correlationId: string;
      reason: string;
    }
  | {
      type: "request_timeout";
      route: string;
      correlationId: string;
      timeoutMs: number;
    }
  | { type: "signal_sent"; route: string }
  | { type: "feed_started"; route: string; hash: string }
  | { type: "feed_joined"; route: string; hash: string }
  | { type: "feed_stopped"; route: string; hash: string }
  | { type: "feed_aborted"; hash: string }
  | { type: "publish_return"; exchange: string }
  | {
      type: "security_denied";
      route: string;
      operation: string;
      direction: "inbound" | "outbound";
    };

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

function toPriorityMeta(
  options?: ScompClientInvokeOptions,
): ScompTransportMessageMeta | undefined {
  if (!options) {
    return undefined;
  }

  const { priority, priorityClass, deadlineAtMs, targetLatencyMs } = options;
  if (
    priority === undefined &&
    priorityClass === undefined &&
    deadlineAtMs === undefined &&
    targetLatencyMs === undefined
  ) {
    return undefined;
  }

  const meta: ScompTransportMessageMeta = {};
  if (priority !== undefined) {
    meta.priority = priority;
  }
  if (priorityClass !== undefined) {
    meta.priorityClass = priorityClass;
  }
  if (deadlineAtMs !== undefined) {
    meta.deadlineAtMs = deadlineAtMs;
  }
  if (targetLatencyMs !== undefined) {
    meta.targetLatencyMs = targetLatencyMs;
  }

  return meta;
}

function toServiceName(route: string): string {
  const parts = route.split(".");
  return parts[0] ?? "default";
}

function toRpcQueue(serviceName: string): string {
  return `scomp.rpc.${serviceName}`;
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
  private replyQueue = "";
  private readonly requestStartTime = new Map<string, number>();
  private readonly requestResolvers = new Map<
    string,
    (value: unknown) => void
  >();
  private readonly requestRejecters = new Map<
    string,
    (error: unknown) => void
  >();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private readonly exchangeToFeedKey = new Map<string, string>();

  constructor(config: RabbitMQTransportConfig) {
    this.config = config;
    this.serializer = config.serializer ?? defaultJsonSerializer;
    this.contentType = this.serializer.contentType ?? "application/json";

    if (config.security?.requireTls && !config.url.startsWith("amqps://")) {
      throw new Error("RabbitMQTransport requires TLS but URL is not amqps://");
    }
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, "topic", { durable: true });

    channel.on("return", (message) => {
      const exchange = message.fields.exchange;
      this.emitEvent({ type: "publish_return", exchange });
      const feedKey = this.exchangeToFeedKey.get(exchange);
      if (!feedKey) {
        return;
      }

      const runningFeed = this.runningFeeds.get(feedKey);
      if (!runningFeed) {
        return;
      }

      this.emitEvent({ type: "feed_aborted", hash: feedKey });
      runningFeed.abortController.abort(new StreamClosedError(feedKey));
    });

    const allRoutes = Object.values(router);
    const serviceNames = Array.from(
      new Set(allRoutes.map((route) => toServiceName(route.route))),
    );

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

    const signalRoutes = allRoutes.filter((route) => route.kind === "signal");
    for (const signalRoute of signalRoutes) {
      const serviceName = toServiceName(signalRoute.route);
      const signalQueue = `scomp.event.${serviceName}.${randomUUID()}`;
      await channel.assertQueue(signalQueue, {
        exclusive: true,
        durable: false,
      });
      await channel.bindQueue(signalQueue, SIGNAL_EXCHANGE, signalRoute.route);
      await channel.consume(signalQueue, async (message) => {
        if (!message) {
          return;
        }

        const body = this.deserializeFromBuffer<ScompTransportRequestEnvelope>(
          message.content,
        );
        const { allowed } = await this.checkSecurity({
          direction: "inbound",
          transport: "rabbitmq",
          route: signalRoute.route,
          operation: "signal",
          payload: body.payload,
          meta: body.meta,
        });
        if (!allowed) {
          channel.ack(message);
          this.emitEvent({
            type: "security_denied",
            route: signalRoute.route,
            operation: "signal",
            direction: "inbound",
          });
          return;
        }

        channel.ack(message);
        await this.invokeRoute(signalRoute, body);
      });
    }
  }

  async request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    return this.sendRpc(route, "request", payload, options);
  }

  async signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = this.mergeMeta(options?.meta, priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
      direction: "outbound",
      transport: "rabbitmq",
      route,
      operation: "signal",
      payload,
      meta: baseMeta,
    });
    if (!allowed) {
      this.emitEvent({
        type: "security_denied",
        route,
        operation: "signal",
        direction: "outbound",
      });
      throw new Error(`Signal not authorized for route: ${route}`);
    }

    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, "topic", { durable: true });

    const content = this.serializeToBuffer({
      route,
      payload,
      op: "signal",
      meta: this.mergeMeta(baseMeta, this.toMessageMeta(principal)),
    } satisfies ScompTransportRequestEnvelope);
    this.assertPayloadSize(content);
    channel.publish(SIGNAL_EXCHANGE, route, content, {
      contentType: this.contentType,
    });

    this.emitEvent({ type: "signal_sent", route });
  }

  async close(): Promise<void> {
    for (const feed of this.runningFeeds.values()) {
      feed.abortController.abort(new StreamClosedError(feed.key));
    }
    this.runningFeeds.clear();
    this.exchangeToFeedKey.clear();

    const closeError = new Error("RabbitMQ transport closed.");
    for (const reject of this.requestRejecters.values()) {
      reject(closeError);
    }
    this.requestRejecters.clear();
    this.requestResolvers.clear();
    this.requestStartTime.clear();

    this.replyQueue = "";

    const channel = this.channel;
    this.channel = undefined;
    if (channel?.close) {
      await channel.close();
    }

    const connection = this.connection;
    this.connection = undefined;
    if (connection?.close) {
      await connection.close();
    }
  }

  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const channel = await self.getChannel();
        const handshake = (await self.sendRpc(
          route,
          "feed_start",
          payload,
          options,
        )) as { exchange: string; hash: string };

        const exchangeName = String(handshake.exchange);
        const feedHash = String(handshake.hash);
        const queueName = (
          await channel.assertQueue("", { exclusive: true, durable: false })
        ).queue;
        await channel.bindQueue(queueName, exchangeName, "");

        const queueBuffer: Array<unknown> = [];
        const waiters: Array<() => void> = [];
        let closed = false;
        const feedBufferLimit = self.getFeedBufferLimit();

        const { consumerTag } = await channel.consume(queueName, (message) => {
          if (!message) {
            return;
          }

          const parsed = self.deserializeFromBuffer<ScompFeedChunkEnvelope>(
            message.content,
          );
          channel.ack(message);

          if (parsed.type === "done") {
            closed = true;
          } else if (parsed.type === "error") {
            closed = true;
            queueBuffer.push(
              Promise.reject(new Error(parsed.message ?? "Feed error")),
            );
          } else {
            if (queueBuffer.length >= feedBufferLimit) {
              closed = true;
              queueBuffer.push(
                Promise.reject(
                  new Error(
                    `Feed buffer high-water mark exceeded (${feedBufferLimit})`,
                  ),
                ),
              );
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
          await channel.unbindQueue(queueName, exchangeName, "");
          await channel.deleteQueue(queueName);
          self.emitEvent({ type: "feed_stopped", route, hash: feedHash });
          await self.sendRpc(route, "feed_stop", { hash: feedHash }, options);
        }
      },
    };
  }

  private async sendRpc(
    route: string,
    op: ScompTransportRequestEnvelope["op"],
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    const priorityMeta = toPriorityMeta(options);
    const baseMeta = this.mergeMeta(options?.meta, priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
      direction: "outbound",
      transport: "rabbitmq",
      route,
      operation: op,
      payload,
      meta: baseMeta,
    });
    if (!allowed) {
      this.emitEvent({
        type: "security_denied",
        route,
        operation: op,
        direction: "outbound",
      });
      throw new Error(`${op} not authorized for route: ${route}`);
    }

    if (this.requestResolvers.size >= this.getMaxInFlightRequests()) {
      throw new Error(
        `In-flight request limit reached: ${this.getMaxInFlightRequests()}`,
      );
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
      op,
      meta: this.mergeMeta(baseMeta, this.toMessageMeta(principal)),
    } satisfies ScompTransportRequestEnvelope);
    this.assertPayloadSize(body);

    channel.sendToQueue(toRpcQueue(serviceName), body, {
      correlationId,
      replyTo: this.replyQueue,
      contentType: this.contentType,
    });

    this.emitEvent({ type: "request_sent", route, correlationId });

    const timeoutMs = this.getRequestTimeoutMs();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestResolvers.delete(correlationId);
        this.requestRejecters.delete(correlationId);
        this.requestStartTime.delete(correlationId);
        this.emitEvent({
          type: "request_timeout",
          route,
          correlationId,
          timeoutMs,
        });
        reject(
          new Error(
            `Request timed out after ${timeoutMs}ms for route: ${route}`,
          ),
        );
      }, timeoutMs);

      void replyPromise.finally(() => clearTimeout(timer));
    });

    return Promise.race([replyPromise, timeoutPromise]);
  }

  private async getConnection(): Promise<ChannelModel> {
    if (!this.connection) {
      this.connection = await this.connectWithRetry();
      this.emitEvent({ type: "connection_opened" });
      this.connection.on("close", () => {
        this.connection = undefined;
        this.channel = undefined;
        this.emitEvent({ type: "connection_closed" });
      });
      this.connection.on("error", (error) => {
        this.emitEvent({
          type: "connection_closed",
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.connection;
  }

  private async getChannel(): Promise<Channel> {
    if (!this.channel) {
      const connection = await this.getConnection();
      this.channel = await connection.createChannel();
      this.emitEvent({ type: "channel_opened" });
      const channel = this.channel;
      if (this.config.prefetch && channel) {
        await channel.prefetch(this.config.prefetch);
      }
    }

    const channel = this.channel;
    if (!channel) {
      throw new Error("RabbitMQ channel is not initialized.");
    }

    return channel;
  }

  private async ensureReplyConsumer(): Promise<void> {
    if (this.replyQueue) {
      return;
    }

    const channel = await this.getChannel();
    const asserted = await channel.assertQueue("", {
      exclusive: true,
      durable: false,
      autoDelete: true,
    });
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

      const body = this.deserializeFromBuffer<ScompTransportResponseEnvelope>(
        message.content,
      );
      if ("error" in body) {
        this.emitEvent({
          type: "request_rejected",
          route: "unknown",
          correlationId,
          reason: String(body.error),
        });
        reject?.(new Error(String(body.error)));
      } else {
        const startedAt =
          this.requestStartTime.get(correlationId) ?? this.now();
        this.emitEvent({
          type: "request_resolved",
          route: "unknown",
          correlationId,
          durationMs: this.now() - startedAt,
        });
        resolve?.(body.payload);
      }
      this.requestStartTime.delete(correlationId);

      channel.ack(message);
    });
  }

  private async handleRpcMessage(message: ConsumeMessage): Promise<void> {
    const channel = await this.getChannel();
    const body = this.deserializeFromBuffer<ScompTransportRequestEnvelope>(
      message.content,
    );
    const route = String(body.route ?? "");
    const { allowed } = await this.checkSecurity({
      direction: "inbound",
      transport: "rabbitmq",
      route,
      operation: body.op,
      payload: body.payload,
      meta: body.meta,
    });
    if (!allowed) {
      channel.ack(message);
      this.emitEvent({
        type: "security_denied",
        route,
        operation: body.op,
        direction: "inbound",
      });
      this.replyWithError(
        message,
        `Inbound operation not authorized for route: ${route}`,
      );
      return;
    }

    const routeEntry = this.router?.[route];

    if (!routeEntry) {
      channel.ack(message);
      this.replyWithError(message, `Route not found: ${route}`);
      return;
    }

    if (routeEntry.kind === "feed") {
      await this.handleFeedRpc(routeEntry, message, body);
      channel.ack(message);
      return;
    }

    try {
      const output = await this.invokeRoute(routeEntry, body);
      this.replyWithPayload(message, output);
    } catch (error) {
      this.replyWithError(message, error);
    } finally {
      channel.ack(message);
    }
  }

  private async handleFeedRpc(
    route: CompiledRoute,
    message: ConsumeMessage,
    body: ScompTransportRequestEnvelope,
  ): Promise<void> {
    const payloadRecord =
      body.payload && typeof body.payload === "object"
        ? (body.payload as { hash?: unknown })
        : undefined;

    if (body.op === "feed_stop") {
      const stopHash = String(payloadRecord?.hash ?? "");
      if (!stopHash) {
        this.replyWithError(
          message,
          "Feed stop request did not include a hash.",
        );
        return;
      }

      const running = this.runningFeeds.get(stopHash);
      if (running) {
        running.subscribers = Math.max(0, running.subscribers - 1);
      }
      this.emitEvent({
        type: "feed_stopped",
        route: route.route,
        hash: stopHash,
      });
      this.replyWithPayload(message, { ok: true });
      return;
    }

    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const hash = String(
      payloadRecord?.hash ??
        createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }),
    );

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers += 1;
      this.emitEvent({ type: "feed_joined", route: route.route, hash });
      this.replyWithPayload(message, { exchange: existing.exchange, hash });
      return;
    }

    const exchange = toFeedExchange(hash);
    const channel = await this.getChannel();
    await channel.assertExchange(exchange, "fanout", {
      durable: false,
      autoDelete: true,
    });

    const runningFeed: RunningFeed = {
      key: hash,
      exchange,
      subscribers: 1,
      abortController: new AbortController(),
    };
    this.runningFeeds.set(hash, runningFeed);
    this.exchangeToFeedKey.set(exchange, hash);
    this.emitEvent({ type: "feed_started", route: route.route, hash });

    const iterable = route.handler(parsedPayload) as AsyncIterable<unknown>;
    void this.publishFeed(runningFeed, iterable);

    this.replyWithPayload(message, { exchange, hash });
  }

  private async publishFeed(
    runningFeed: RunningFeed,
    iterable: AsyncIterable<unknown>,
  ): Promise<void> {
    const channel = await this.getChannel();

    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        channel.publish(
          runningFeed.exchange,
          "",
          this.serializeToBuffer({
            channel: "feed",
            hash: runningFeed.key,
            type: "next",
            payload: chunk,
          } satisfies ScompFeedChunkEnvelope),
          {
            contentType: this.contentType,
            mandatory: true,
          },
        );
        await this.waitForChannelDrainIfNeeded(channel);
      }

      channel.publish(
        runningFeed.exchange,
        "",
        this.serializeToBuffer({
          channel: "feed",
          hash: runningFeed.key,
          type: "done",
        } satisfies ScompFeedChunkEnvelope),
        {
          contentType: this.contentType,
          mandatory: true,
        },
      );
      await this.waitForChannelDrainIfNeeded(channel);
    } catch (error) {
      channel.publish(
        runningFeed.exchange,
        "",
        this.serializeToBuffer({
          channel: "feed",
          hash: runningFeed.key,
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies ScompFeedChunkEnvelope),
        {
          contentType: this.contentType,
          mandatory: true,
        },
      );
      await this.waitForChannelDrainIfNeeded(channel);
    } finally {
      this.runningFeeds.delete(runningFeed.key);
      this.exchangeToFeedKey.delete(runningFeed.exchange);
    }
  }

  private async invokeRoute(
    route: CompiledRoute,
    body: ScompTransportRequestEnvelope,
  ): Promise<unknown> {
    const payload = route.parser ? route.parser(body.payload) : body.payload;
    return route.handler(payload);
  }

  private replyWithPayload(message: ConsumeMessage, payload: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(
      replyTo,
      this.serializeToBuffer({
        payload,
      } satisfies ScompTransportResponseEnvelope),
      {
        correlationId: message.properties.correlationId,
        contentType: this.contentType,
      },
    );
  }

  private replyWithError(message: ConsumeMessage, error: unknown): void {
    const replyTo = message.properties.replyTo;
    if (!replyTo) {
      return;
    }

    this.channel?.sendToQueue(
      replyTo,
      this.serializeToBuffer({
        error: error instanceof Error ? error.message : String(error),
      } satisfies ScompTransportResponseEnvelope),
      {
        correlationId: message.properties.correlationId,
        contentType: this.contentType,
      },
    );
  }

  private serializeToBuffer(value: unknown): Buffer {
    return Buffer.from(this.serializer.stringify(value));
  }

  private deserializeFromBuffer<T = unknown>(value: Buffer): T {
    return this.serializer.parse<T>(value.toString("utf8"));
  }

  private assertPayloadSize(payload: Buffer): void {
    const limit = this.config.security?.maxPayloadBytes;
    if (!limit) {
      return;
    }

    if (payload.byteLength > limit) {
      throw new Error(`Payload exceeds maxPayloadBytes (${limit}).`);
    }
  }

  private toMessageMeta(
    principal: ScompTransportPrincipal | undefined,
  ): ScompTransportMessageMeta | undefined {
    if (!principal) {
      return undefined;
    }

    return {
      auth: {
        subject: principal.subject,
        tenantId: principal.tenantId,
        scopes: principal.scopes,
        claims: principal.claims,
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
        authType: principal.authType,
      },
      tenantId: principal.tenantId,
    };
  }

  private mergeMeta(
    baseMeta: ScompTransportMessageMeta | undefined,
    overlayMeta: ScompTransportMessageMeta | undefined,
  ): ScompTransportMessageMeta | undefined {
    if (!baseMeta && !overlayMeta) {
      return undefined;
    }

    return {
      ...(baseMeta ?? {}),
      ...(overlayMeta ?? {}),
    };
  }

  private async checkSecurity(
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
    const policy = this.config.security?.policy;

    const principal = policy?.authenticate
      ? await policy.authenticate(ctx)
      : undefined;

    if (policy?.authorize) {
      const allowed = Boolean(
        await policy.authorize({ ...ctx, principal: principal ?? undefined }),
      );
      return { allowed, principal: principal ?? undefined };
    }

    const legacyAuthorize = this.config.security?.authorize;
    if (legacyAuthorize) {
      const allowed = Boolean(
        await legacyAuthorize({
          direction: ctx.direction,
          route: ctx.route,
          operation: ctx.operation,
          payload: ctx.payload,
        }),
      );
      return { allowed, principal: principal ?? undefined };
    }

    return { allowed: true, principal: principal ?? undefined };
  }

  private async connectWithRetry(): Promise<ChannelModel> {
    const maxAttempts = this.config.retry?.maxAttempts ?? 6;
    const baseDelayMs = this.config.retry?.baseDelayMs ?? 250;
    const maxDelayMs = this.config.retry?.maxDelayMs ?? 8_000;

    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        if (attempt > 1) {
          this.emitEvent({ type: "connection_reconnect", attempt });
        }
        return await amqp.connect(this.config.url);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          break;
        }

        const jitter = Math.floor(Math.random() * 100);
        const delay = Math.min(
          maxDelayMs,
          baseDelayMs * 2 ** (attempt - 1) + jitter,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error(
      `Unable to connect to RabbitMQ after ${maxAttempts} attempts: ${String(lastError)}`,
    );
  }

  private async waitForChannelDrainIfNeeded(channel: Channel): Promise<void> {
    const writable = (channel as unknown as { writable?: boolean }).writable;
    if (writable === false) {
      await once(channel, "drain");
    }
  }

  private emitEvent(event: RabbitMQTransportEvent): void {
    this.config.observability?.onEvent?.(event);
  }

  private now(): number {
    return this.config.observability?.now?.() ?? Date.now();
  }

  private getRequestTimeoutMs(): number {
    return this.config.performance?.requestTimeoutMs ?? 20_000;
  }

  private getMaxInFlightRequests(): number {
    return this.config.performance?.maxInFlightRequests ?? 10_000;
  }

  private getFeedBufferLimit(): number {
    return this.config.performance?.feedBufferHighWaterMark ?? 1_024;
  }
}

export function createRabbitMqTransport(
  config: RabbitMQTransportConfig,
): RabbitMQTransport {
  return new RabbitMQTransport(config);
}

export {
  createJsonSerializer,
  defaultJsonSerializer,
  type ExtendedJsonSerializerOptions,
} from "./serialization";
