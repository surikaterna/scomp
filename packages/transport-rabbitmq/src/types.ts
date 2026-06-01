import type { CompiledRoute, ScompPriorityDecision } from "@scompr/core";
import { resolveScompPriority } from "@scompr/core";
import type { ScompTransportMessageMeta, ScompTransportRequestEnvelope } from "@scompr/types";

export const SIGNAL_EXCHANGE = "scomp.signals";

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = "StreamClosedError";
  }
}

export interface RunningFeed {
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
      type: "priority_decision";
      direction: "inbound" | "outbound";
      route: string;
      operation: ScompTransportRequestEnvelope["op"];
      source: ScompPriorityDecision["source"];
      requested: ScompPriorityDecision["requested"];
      effective: ScompPriorityDecision["effective"];
    };

export interface RabbitMQTransportObservabilityConfig {
  onEvent?: (event: RabbitMQTransportEvent) => void;
  now?: () => number;
}

export interface RabbitMQTransportConfig {
  url: string;
  prefetch?: number;
  serviceName?: string;
  serializer?: import("@scompr/types").ScompSerializer;
  meta?: ScompTransportMessageMeta | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
  retry?: RabbitMQTransportRetryConfig;
  security?: RabbitMQTransportSecurityConfig;
  performance?: RabbitMQTransportPerformanceConfig;
  observability?: RabbitMQTransportObservabilityConfig;
}

export type RouterTable = Record<string, CompiledRoute>;

export function toServiceName(route: string): string {
  const parts = route.split(".");
  return parts[0] ?? "default";
}

export function toRpcQueue(serviceName: string): string {
  return `scomp.rpc.${serviceName}`;
}

export function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

export function buildPriorityDecisionEvent(
  direction: "inbound" | "outbound",
  route: string,
  operation: ScompTransportRequestEnvelope["op"],
  meta?: ScompTransportMessageMeta,
): Extract<RabbitMQTransportEvent, { type: "priority_decision" }> {
  const decision = resolveScompPriority({
    route,
    operation,
    meta: meta as (ScompTransportMessageMeta & Record<string, unknown>) | undefined,
  });
  return {
    type: "priority_decision",
    direction,
    route,
    operation,
    source: decision.source,
    requested: decision.requested,
    effective: decision.effective,
  };
}
