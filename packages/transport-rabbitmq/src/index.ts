import { randomUUID } from "node:crypto";
import type { ITransport, ScompClientInvokeOptions, ScompHandlerContext } from "@scompr/core";
import { mergeMeta, toPriorityMeta } from "@scompr/transport-shared";
import type { ScompSerializer, ScompTransportMessageMeta, ScompTransportRequestEnvelope } from "@scompr/types";
import type { Channel, ChannelModel } from "amqplib";
import { type ClientContext, createFeedConsumer, sendRpc } from "./rabbitmq-client";
import { connectWithRetry } from "./rabbitmq-connection";
import { handleRpcMessage } from "./rabbitmq-rpc";
import { defaultJsonSerializer } from "./serialization";
import {
  buildPriorityDecisionEvent,
  type RabbitMQTransportConfig,
  type RabbitMQTransportEvent,
  type RouterTable,
  type RunningFeed,
  SIGNAL_EXCHANGE,
  StreamClosedError,
  toRpcQueue,
  toServiceName,
} from "./types";

export class RabbitMQTransport implements ITransport {
  private readonly config: RabbitMQTransportConfig;
  private readonly serializer: ScompSerializer;
  private readonly contentType: string;
  private connection?: ChannelModel;
  private channel?: Channel;
  private router?: RouterTable;
  private replyQueue = "";
  private readonly requestStartTime = new Map<string, number>();
  private readonly requestResolvers = new Map<string, (value: unknown) => void>();
  private readonly requestRejecters = new Map<string, (error: unknown) => void>();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private readonly exchangeToFeedKey = new Map<string, string>();
  private readonly feedConsumer: (
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ) => AsyncIterable<unknown>;

  constructor(config: RabbitMQTransportConfig) {
    this.config = config;
    this.serializer = config.serializer ?? defaultJsonSerializer;
    this.contentType = this.serializer.contentType ?? "application/json";

    if (config.security?.requireTls && !config.url.startsWith("amqps://")) {
      throw new Error("RabbitMQTransport requires TLS but URL is not amqps://");
    }

    this.feedConsumer = createFeedConsumer(
      this.clientContext(),
      (route, payload, options) => this.signal(route, payload, options),
      () => this.getFeedBufferLimit(),
    );
  }

  async registerRoutes(router: RouterTable): Promise<void> {
    this.router = router;
    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, "topic", { durable: true });

    channel.on("return", (message) => {
      const exchange = message.fields.exchange;
      this.emitEvent({ type: "publish_return", exchange });
      const feedKey = this.exchangeToFeedKey.get(exchange);
      if (!feedKey) return;

      const runningFeed = this.runningFeeds.get(feedKey);
      if (!runningFeed) return;

      this.emitEvent({ type: "feed_aborted", hash: feedKey });
      runningFeed.abortController.abort(new StreamClosedError(feedKey));
    });

    const allRoutes = Object.values(router);
    const serviceNames = Array.from(new Set(allRoutes.map((route) => toServiceName(route.route))));

    for (const serviceName of serviceNames) {
      const rpcQueue = toRpcQueue(serviceName);
      await channel.assertQueue(rpcQueue, { durable: true });
      await channel.consume(rpcQueue, async (message) => {
        if (!message) return;
        await handleRpcMessage(this.rpcContext(), message);
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
        if (!message) return;

        const body = this.deserializeFromBuffer<ScompTransportRequestEnvelope>(message.content);
        this.emitPriorityDecision("inbound", signalRoute.route, "signal", body.meta);

        channel.ack(message);
        const routeEntry = this.router?.[signalRoute.route];
        if (routeEntry) {
          const payload = routeEntry.parser ? routeEntry.parser(body.payload) : body.payload;
          const handlerCtx: ScompHandlerContext = {
            route: signalRoute.route,
            operation: "signal",
            meta: body.meta,
          };
          await routeEntry.handler(payload, handlerCtx);
        }
      });
    }
  }

  async request(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
    return sendRpc(this.clientContext(), route, "request", payload, options);
  }

  async signal(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<void> {
    const priorityMeta = toPriorityMeta(options);
    const resolvedConfigMeta = await this.resolveConfigMeta();
    const baseMeta = mergeMeta(mergeMeta(resolvedConfigMeta, options?.meta), priorityMeta);
    this.emitPriorityDecision("outbound", route, "signal", baseMeta);

    const channel = await this.getChannel();
    await channel.assertExchange(SIGNAL_EXCHANGE, "topic", { durable: true });

    const content = this.serializeToBuffer({
      v: 1,
      route,
      payload,
      op: "signal",
      meta: baseMeta,
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
    for (const reject of this.requestRejecters.values()) reject(closeError);
    this.requestRejecters.clear();
    this.requestResolvers.clear();
    this.requestStartTime.clear();
    this.replyQueue = "";

    const channel = this.channel;
    this.channel = undefined;
    if (channel?.close) await channel.close();

    const connection = this.connection;
    this.connection = undefined;
    if (connection?.close) await connection.close();
  }

  feed(route: string, payload: unknown, options?: ScompClientInvokeOptions): AsyncIterable<unknown> {
    return this.feedConsumer(route, payload, options);
  }

  async invoke(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
    // RabbitMQ transport can look up the route kind from its own router
    const routeEntry = this.router?.[route];
    if (routeEntry?.kind === "signal") {
      await this.signal(route, payload, options);
      return undefined;
    }
    if (routeEntry?.kind === "feed") {
      return this.feedConsumer(route, payload, options);
    }
    // Default to request
    return sendRpc(this.clientContext(), route, "request", payload, options);
  }

  private clientContext(): ClientContext {
    return {
      serializer: this.serializer,
      contentType: this.contentType,
      configMeta: this.config.meta,
      getChannel: () => this.getChannel(),
      emitEvent: (e) => this.emitEvent(e),
      emitPriorityDecision: (d, r, o, m) => this.emitPriorityDecision(d, r, o, m),
      assertPayloadSize: (p) => this.assertPayloadSize(p),
      requestStartTime: this.requestStartTime,
      requestResolvers: this.requestResolvers,
      requestRejecters: this.requestRejecters,
      getReplyQueue: () => this.replyQueue,
      setReplyQueue: (q) => {
        this.replyQueue = q;
      },
      now: () => this.now(),
      getRequestTimeoutMs: () => this.getRequestTimeoutMs(),
      getMaxInFlightRequests: () => this.getMaxInFlightRequests(),
    };
  }

  private rpcContext() {
    return {
      router: this.router,
      getChannel: () => this.getChannel(),
      serializeToBuffer: (v: unknown) => this.serializeToBuffer(v),
      deserializeFromBuffer: <T>(v: Buffer) => this.deserializeFromBuffer<T>(v),
      contentType: this.contentType,
      serializer: this.serializer,
      emitEvent: (e: RabbitMQTransportEvent) => this.emitEvent(e),
      emitPriorityDecision: (
        d: "inbound" | "outbound",
        r: string,
        o: ScompTransportRequestEnvelope["op"],
        m?: ScompTransportMessageMeta,
      ) => this.emitPriorityDecision(d, r, o, m),
      runningFeeds: this.runningFeeds,
      exchangeToFeedKey: this.exchangeToFeedKey,
      getCurrentChannel: () => this.channel,
    };
  }

  private async getConnection(): Promise<ChannelModel> {
    if (!this.connection) {
      this.connection = await connectWithRetry({ ...this.config.retry, url: this.config.url }, (event) =>
        this.emitEvent(event),
      );
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
      if (this.config.prefetch && this.channel) {
        await this.channel.prefetch(this.config.prefetch);
      }
    }
    if (!this.channel) throw new Error("RabbitMQ channel is not initialized.");
    return this.channel;
  }

  private serializeToBuffer(value: unknown): Buffer {
    return Buffer.from(this.serializer.stringify(value));
  }

  private deserializeFromBuffer<T = unknown>(value: Buffer): T {
    return this.serializer.parse<T>(value.toString("utf8"));
  }

  private assertPayloadSize(payload: Buffer): void {
    const limit = this.config.security?.maxPayloadBytes;
    if (limit && payload.byteLength > limit) {
      throw new Error(`Payload exceeds maxPayloadBytes (${limit}).`);
    }
  }

  private emitEvent(event: RabbitMQTransportEvent): void {
    this.config.observability?.onEvent?.(event);
  }

  private emitPriorityDecision(
    direction: "inbound" | "outbound",
    route: string,
    operation: ScompTransportRequestEnvelope["op"],
    meta?: ScompTransportMessageMeta,
  ): void {
    this.emitEvent(buildPriorityDecisionEvent(direction, route, operation, meta));
  }

  private async resolveConfigMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const metaConfig = this.config.meta;
    if (!metaConfig) return undefined;
    if (typeof metaConfig === "function") return metaConfig();
    return metaConfig;
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

export function createRabbitMqTransport(config: RabbitMQTransportConfig): RabbitMQTransport {
  return new RabbitMQTransport(config);
}

export {
  createJsonSerializer,
  defaultJsonSerializer,
  type ExtendedJsonSerializerOptions,
} from "./serialization";
export {
  type RabbitMQTransportConfig,
  type RabbitMQTransportEvent,
  type RabbitMQTransportObservabilityConfig,
  type RabbitMQTransportPerformanceConfig,
  type RabbitMQTransportRetryConfig,
  type RabbitMQTransportSecurityConfig,
  StreamClosedError,
} from "./types";
