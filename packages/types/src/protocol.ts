import { createHash } from "node:crypto";

export type ScompTransportOperation =
  | "request"
  | "signal"
  | "feed_start"
  | "feed_stop";

export type ScompPriorityIndex = 0 | 1 | 2 | 3 | 4;

export type ScompPriorityClass = `P${ScompPriorityIndex}`;

export type ScompPriorityHint =
  | ScompPriorityClass
  | Lowercase<ScompPriorityClass>
  | ScompPriorityIndex
  | `${ScompPriorityIndex}`;

export interface ScompTransportPriorityHints {
  priority?: ScompPriorityHint;
  priorityClass?: ScompPriorityClass;
  deadlineAtMs?: number;
  targetLatencyMs?: number;
}

export interface ScompTransportMessageMeta {
  auth?: unknown;
  traceId?: string;
  tenantId?: string;
  tags?: Record<string, string>;
  priority?: ScompPriorityHint;
  priorityClass?: ScompPriorityClass;
  deadlineAtMs?: number;
  targetLatencyMs?: number;
}

export interface ScompTransportPrincipal {
  subject: string;
  tenantId?: string;
  scopes?: Array<string>;
  claims?: Record<string, unknown>;
  issuedAt?: number;
  expiresAt?: number;
  authType?: string;
}

export interface ScompTransportSecurityContext {
  direction: "inbound" | "outbound";
  transport: string;
  route: string;
  operation: ScompTransportOperation;
  payload: unknown;
  meta?: ScompTransportMessageMeta;
  principal?: ScompTransportPrincipal;
}

export interface ScompTransportSecurityPolicy {
  authenticate?: (
    context: Omit<ScompTransportSecurityContext, "principal">,
  ) => ScompTransportPrincipal | null | Promise<ScompTransportPrincipal | null>;
  authorize?: (
    context: ScompTransportSecurityContext,
  ) => boolean | Promise<boolean>;
}

export interface ScompTransportRequestEnvelope {
  id?: string;
  route: string;
  op: ScompTransportOperation;
  payload?: unknown;
  meta?: ScompTransportMessageMeta;
}

export type ScompTransportRequest = ScompTransportRequestEnvelope;

export interface ScompTransportSuccessResponseEnvelope {
  id?: string;
  payload?: unknown;
  meta?: ScompTransportMessageMeta;
}

export interface ScompTransportErrorResponseEnvelope {
  id?: string;
  error: string;
  meta?: ScompTransportMessageMeta;
}

export type ScompTransportSuccessResponse =
  ScompTransportSuccessResponseEnvelope;

export type ScompTransportErrorResponse = ScompTransportErrorResponseEnvelope;

export type ScompTransportResponseEnvelope =
  | ScompTransportSuccessResponseEnvelope
  | ScompTransportErrorResponseEnvelope;

export type ScompTransportResponse = ScompTransportResponseEnvelope;

export type ScompFeedChunkType = "next" | "done" | "error";

export interface ScompFeedChunkEnvelope {
  channel: "feed";
  hash: string;
  type: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
  meta?: ScompTransportMessageMeta;
}

export type ScompFeedChunk = ScompFeedChunkEnvelope;

export interface FeedHashOptions {
  hashKey?: (payload: unknown) => string;
  stringify?: (value: unknown) => string;
}

export function createFeedHash(
  route: string,
  payload: unknown,
  options: FeedHashOptions = {},
): string {
  if (options.hashKey) {
    return options.hashKey(payload);
  }

  const stringify = options.stringify ?? JSON.stringify;
  const serialized = stringify(payload ?? {});
  return createHash("sha256")
    .update(`${route}:${serialized}`)
    .digest("hex")
    .slice(0, 32);
}

export interface ScompSerializer {
  stringify(value: unknown): string;
  parse<T = unknown>(text: string): T;
  contentType?: string;
}
