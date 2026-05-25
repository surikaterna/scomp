import { randomUUID } from "node:crypto";
import type { ScompClientInvokeOptions } from "@scomp/core";
import { mergeMeta, toPriorityMeta } from "@scomp/transport-shared";
import type {
  ScompFeedChunkEnvelope,
  ScompSerializer,
  ScompTransportMessageMeta,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scomp/types";
import type { Channel } from "amqplib";
import { type RabbitMQTransportEvent, toRpcQueue, toServiceName } from "./types";

export interface ClientContext {
  serializer: ScompSerializer;
  contentType: string;
  configMeta?: ScompTransportMessageMeta | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  getChannel: () => Promise<Channel>;
  emitEvent: (event: RabbitMQTransportEvent) => void;
  emitPriorityDecision: (
    direction: "inbound" | "outbound",
    route: string,
    operation: ScompTransportRequestEnvelope["op"],
    meta?: ScompTransportMessageMeta,
  ) => void;
  assertPayloadSize: (payload: Buffer) => void;
  requestStartTime: Map<string, number>;
  requestResolvers: Map<string, (value: unknown) => void>;
  requestRejecters: Map<string, (error: unknown) => void>;
  getReplyQueue: () => string;
  setReplyQueue: (queue: string) => void;
  now: () => number;
  getRequestTimeoutMs: () => number;
  getMaxInFlightRequests: () => number;
}

async function resolveMeta(configMeta: ClientContext["configMeta"]): Promise<ScompTransportMessageMeta | undefined> {
  if (!configMeta) return undefined;
  if (typeof configMeta === "function") return configMeta();
  return configMeta;
}

export async function sendRpc(
  ctx: ClientContext,
  route: string,
  op: ScompTransportRequestEnvelope["op"],
  payload: unknown,
  options?: ScompClientInvokeOptions,
): Promise<unknown> {
  const priorityMeta = toPriorityMeta(options);
  const resolvedConfigMeta = await resolveMeta(ctx.configMeta);
  const baseMeta = mergeMeta(mergeMeta(resolvedConfigMeta, options?.meta), priorityMeta);
  ctx.emitPriorityDecision("outbound", route, op, baseMeta);

  if (ctx.requestResolvers.size >= ctx.getMaxInFlightRequests()) {
    throw new Error(`In-flight request limit reached: ${ctx.getMaxInFlightRequests()}`);
  }

  const channel = await ctx.getChannel();
  await ensureReplyConsumer(ctx);

  const correlationId = randomUUID();
  ctx.requestStartTime.set(correlationId, ctx.now());

  const replyPromise = new Promise<unknown>((resolve, reject) => {
    ctx.requestResolvers.set(correlationId, resolve);
    ctx.requestRejecters.set(correlationId, reject);
  });

  const serviceName = toServiceName(route);
  const body = serializeToBuffer(ctx.serializer, {
    route,
    payload,
    op,
    meta: baseMeta,
  } satisfies ScompTransportRequestEnvelope);
  ctx.assertPayloadSize(body);

  channel.sendToQueue(toRpcQueue(serviceName), body, {
    correlationId,
    replyTo: ctx.getReplyQueue(),
    contentType: ctx.contentType,
  });

  ctx.emitEvent({ type: "request_sent", route, correlationId });

  const timeoutMs = ctx.getRequestTimeoutMs();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.requestResolvers.delete(correlationId);
      ctx.requestRejecters.delete(correlationId);
      ctx.requestStartTime.delete(correlationId);
      ctx.emitEvent({
        type: "request_timeout",
        route,
        correlationId,
        timeoutMs,
      });
      reject(new Error(`Request timed out after ${timeoutMs}ms for route: ${route}`));
    }, timeoutMs);

    void replyPromise.finally(() => clearTimeout(timer));
  });

  return Promise.race([replyPromise, timeoutPromise]);
}

async function ensureReplyConsumer(ctx: ClientContext): Promise<void> {
  if (ctx.getReplyQueue()) {
    return;
  }

  const channel = await ctx.getChannel();
  const asserted = await channel.assertQueue("", {
    exclusive: true,
    durable: false,
    autoDelete: true,
  });
  ctx.setReplyQueue(asserted.queue);

  await channel.consume(asserted.queue, (message) => {
    if (!message) {
      return;
    }

    const correlationId = message.properties.correlationId;
    const resolve = ctx.requestResolvers.get(correlationId);
    const reject = ctx.requestRejecters.get(correlationId);

    ctx.requestResolvers.delete(correlationId);
    ctx.requestRejecters.delete(correlationId);

    const body = deserializeFromBuffer<ScompTransportResponseEnvelope>(ctx.serializer, message.content);
    if ("error" in body) {
      ctx.emitEvent({
        type: "request_rejected",
        route: "unknown",
        correlationId,
        reason: String(body.error),
      });
      reject?.(new Error(String(body.error)));
    } else {
      const startedAt = ctx.requestStartTime.get(correlationId) ?? ctx.now();
      ctx.emitEvent({
        type: "request_resolved",
        route: "unknown",
        correlationId,
        durationMs: ctx.now() - startedAt,
      });
      resolve?.(body.payload);
    }
    ctx.requestStartTime.delete(correlationId);

    channel.ack(message);
  });
}

export function createFeedConsumer(
  ctx: ClientContext,
  signal: (route: string, payload: unknown, options?: ScompClientInvokeOptions) => Promise<void>,
  getFeedBufferLimit: () => number,
): (route: string, payload: unknown, options?: ScompClientInvokeOptions) => AsyncIterable<unknown> {
  return (route, payload, options) => ({
    async *[Symbol.asyncIterator]() {
      const channel = await ctx.getChannel();
      const handshake = (await sendRpc(ctx, route, "feed", payload, options)) as {
        exchange: string;
        feed: string;
      };

      const exchangeName = String(handshake.exchange);
      const feedHash = String(handshake.feed);
      const queueName = (await channel.assertQueue("", { exclusive: true, durable: false })).queue;
      await channel.bindQueue(queueName, exchangeName, "");

      const queueBuffer: Array<unknown> = [];
      const waiters: Array<() => void> = [];
      let closed = false;
      const feedBufferLimit = getFeedBufferLimit();

      const { consumerTag } = await channel.consume(queueName, (message) => {
        if (!message) {
          return;
        }

        const parsed = deserializeFromBuffer<ScompFeedChunkEnvelope>(ctx.serializer, message.content);
        channel.ack(message);

        if (parsed.type === "done") {
          closed = true;
        } else if (parsed.type === "error") {
          closed = true;
          queueBuffer.push(Promise.reject(new Error(parsed.message ?? "Feed error")));
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
        await channel.unbindQueue(queueName, exchangeName, "");
        await channel.deleteQueue(queueName);
        ctx.emitEvent({ type: "feed_stopped", route, hash: feedHash });
        await signal(route, {}, {
          ...options,
          meta: {
            ...options?.meta,
            __scomp_feed: feedHash,
            __scomp_method: "__scomp.unsubscribe",
          },
        } as ScompClientInvokeOptions);
      }
    },
  });
}

function serializeToBuffer(serializer: ScompSerializer, value: unknown): Buffer {
  return Buffer.from(serializer.stringify(value));
}

function deserializeFromBuffer<T = unknown>(serializer: ScompSerializer, value: Buffer): T {
  return serializer.parse<T>(value.toString("utf8"));
}
