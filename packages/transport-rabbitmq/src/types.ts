import type { CompiledRoute, ScompPriorityDecision } from "@scomp/core";
import { resolveScompPriority } from "@scomp/core";
import type {
  ScompTransportMessageMeta,
  ScompTransportPrincipal,
  ScompTransportRequestEnvelope,
  ScompTransportSecurityContext,
  ScompTransportSecurityPolicy,
} from "@scomp/types";

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
    }
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
  serializer?: import("@scomp/types").ScompSerializer;
  meta?:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>);
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

export async function checkTransportSecurity(
  security: RabbitMQTransportSecurityConfig | undefined,
  ctx: Omit<ScompTransportSecurityContext, "principal">,
): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
  const policy = security?.policy;

  const principal = policy?.authenticate
    ? await policy.authenticate(ctx)
    : undefined;

  if (policy?.authorize) {
    const allowed = Boolean(
      await policy.authorize({ ...ctx, principal: principal ?? undefined }),
    );
    return { allowed, principal: principal ?? undefined };
  }

  const legacyAuthorize = security?.authorize;
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

export function buildPriorityDecisionEvent(
  direction: "inbound" | "outbound",
  route: string,
  operation: ScompTransportRequestEnvelope["op"],
  meta?: ScompTransportMessageMeta,
): Extract<RabbitMQTransportEvent, { type: "priority_decision" }> {
  const decision = resolveScompPriority({
    route,
    operation,
    meta: meta as
      | (ScompTransportMessageMeta & Record<string, unknown>)
      | undefined,
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
