import { type CompiledRoute, createFeedHash, type ScompHandlerContext } from "@scomp/core";
import type { ScompErrorCode, ScompTransportRequestEnvelope, ScompTransportResponseEnvelope } from "@scomp/types";
import type { Channel, ConsumeMessage } from "amqplib";
import { publishFeed } from "./rabbitmq-feed";
import { type RabbitMQTransportEvent, type RouterTable, type RunningFeed, toFeedExchange } from "./types";

export interface RpcContext {
  router?: RouterTable;
  getChannel: () => Promise<Channel>;
  serializeToBuffer: (value: unknown) => Buffer;
  deserializeFromBuffer: <T = unknown>(value: Buffer) => T;
  contentType: string;
  serializer: import("@scomp/types").ScompSerializer;
  emitEvent: (event: RabbitMQTransportEvent) => void;
  emitPriorityDecision: (
    direction: "inbound" | "outbound",
    route: string,
    operation: ScompTransportRequestEnvelope["op"],
    meta?: import("@scomp/types").ScompTransportMessageMeta,
  ) => void;
  runningFeeds: Map<string, RunningFeed>;
  exchangeToFeedKey: Map<string, string>;
  getCurrentChannel: () => Channel | undefined;
}

export async function handleRpcMessage(ctx: RpcContext, message: ConsumeMessage): Promise<void> {
  const channel = await ctx.getChannel();
  const body = ctx.deserializeFromBuffer<ScompTransportRequestEnvelope>(message.content);
  const route = String(body.route ?? "");
  ctx.emitPriorityDecision("inbound", route, body.op, body.meta);

  const routeEntry = ctx.router?.[route];

  if (!routeEntry) {
    channel.ack(message);
    replyWithError(ctx, message, `Route not found: ${route}`, "ROUTE_NOT_FOUND");
    return;
  }

  if (routeEntry.kind === "feed") {
    const handlerCtx: ScompHandlerContext = {
      route,
      operation: "feed",
      meta: body.meta,
    };
    await handleFeedRpc(ctx, routeEntry, message, body, handlerCtx);
    channel.ack(message);
    return;
  }

  try {
    const handlerCtx: ScompHandlerContext = {
      route,
      operation: body.op as ScompHandlerContext["operation"],
      meta: body.meta,
    };
    const output = await invokeRoute(routeEntry, body, handlerCtx);
    replyWithPayload(ctx, message, output);
  } catch (error) {
    const code =
      (error as unknown as { code?: string })?.code === "UNAUTHORIZED" ? ("UNAUTHORIZED" as ScompErrorCode) : undefined;
    replyWithError(ctx, message, error, code);
  } finally {
    channel.ack(message);
  }
}

async function handleFeedRpc(
  ctx: RpcContext,
  route: CompiledRoute,
  message: ConsumeMessage,
  body: ScompTransportRequestEnvelope,
  handlerCtx: ScompHandlerContext,
): Promise<void> {
  const rawPayload = body.payload;
  const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
  const hash = String(body.feed ?? createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }));

  const existing = ctx.runningFeeds.get(hash);
  if (existing) {
    existing.subscribers += 1;
    ctx.emitEvent({ type: "feed_joined", route: route.route, hash });
    replyWithPayload(ctx, message, {
      exchange: existing.exchange,
      feed: hash,
    });
    return;
  }

  const exchange = toFeedExchange(hash);
  const channel = await ctx.getChannel();
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
  ctx.runningFeeds.set(hash, runningFeed);
  ctx.exchangeToFeedKey.set(exchange, hash);
  ctx.emitEvent({ type: "feed_started", route: route.route, hash });

  const iterable = route.handler(parsedPayload, handlerCtx) as AsyncIterable<unknown>;
  void publishFeed(channel, runningFeed, iterable, ctx.serializer, ctx.contentType, (feed) => {
    ctx.runningFeeds.delete(feed.key);
    ctx.exchangeToFeedKey.delete(feed.exchange);
  });

  replyWithPayload(ctx, message, { exchange, feed: hash });
}

function invokeRoute(
  route: CompiledRoute,
  body: ScompTransportRequestEnvelope,
  ctx?: ScompHandlerContext,
): Promise<unknown> {
  const payload = route.parser ? route.parser(body.payload) : body.payload;
  return route.handler(payload, ctx) as Promise<unknown>;
}

export function replyWithPayload(ctx: RpcContext, message: ConsumeMessage, payload: unknown): void {
  const replyTo = message.properties.replyTo;
  if (!replyTo) {
    return;
  }

  ctx.getCurrentChannel()?.sendToQueue(
    replyTo,
    ctx.serializeToBuffer({
      payload,
    } satisfies ScompTransportResponseEnvelope),
    {
      correlationId: message.properties.correlationId,
      contentType: ctx.contentType,
    },
  );
}

export function replyWithError(ctx: RpcContext, message: ConsumeMessage, error: unknown, code?: ScompErrorCode): void {
  const replyTo = message.properties.replyTo;
  if (!replyTo) {
    return;
  }

  ctx.getCurrentChannel()?.sendToQueue(
    replyTo,
    ctx.serializeToBuffer({
      error: error instanceof Error ? error.message : String(error),
      code,
    } satisfies ScompTransportResponseEnvelope),
    {
      correlationId: message.properties.correlationId,
      contentType: ctx.contentType,
    },
  );
}
