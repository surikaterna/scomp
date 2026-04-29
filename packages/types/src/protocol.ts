export type ScompTransportOperation = "request" | "signal" | "feed";

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

export interface ScompClientInvokeOptions extends ScompTransportPriorityHints {
  meta?: ScompTransportMessageMeta;
  /** Feed subscription ID for controller-scoped calls. */
  feed?: string;
  /** Controller method name for controller-scoped calls. */
  method?: string;
}

export const SCOMP_CONTROL_PLANE_NAMESPACE = "__scomp";

export type ScompControlPlaneRoute = "__scomp.discover" | "__scomp.resolve" | "__scomp.health";

export interface ScompControlPlaneNodeRef {
  id: string;
}

export interface ScompControlPlaneEndpoint {
  route: string;
  channel: string;
  transport?: string;
  nodeId?: string;
}

export interface ScompControlPlaneDiscoverRequest {
  servicePrefix?: string;
  includeRoutes?: boolean;
}

export interface ScompControlPlaneDiscoveredService {
  name: string;
  routes?: Array<string>;
}

export interface ScompControlPlaneDiscoverResponse {
  services: Array<ScompControlPlaneDiscoveredService>;
  node: ScompControlPlaneNodeRef;
  generatedAt?: string;
  ttlMs?: number;
}

export interface ScompControlPlaneResolveRequest {
  route: string;
  channel?: string;
}

export interface ScompControlPlaneResolveResponse {
  resolved: boolean;
  endpoint?: ScompControlPlaneEndpoint;
  candidates?: Array<ScompControlPlaneEndpoint>;
  fallbackUsed: boolean;
}

export type ScompControlPlaneHealthStatus = "ok" | "degraded" | "down";

export interface ScompControlPlaneHealthCheck {
  name: string;
  status: ScompControlPlaneHealthStatus;
  message?: string;
}

export interface ScompControlPlaneHealthRequest {
  verbose?: boolean;
  mode?: "shallow" | "deep";
  service?: string;
}

export interface ScompControlPlaneHealthResponse {
  status: ScompControlPlaneHealthStatus;
  checks?: Array<ScompControlPlaneHealthCheck>;
  node: ScompControlPlaneNodeRef;
  timestamp?: string;
}

export interface ScompControlPlaneRouteContracts {
  "__scomp.discover": {
    request: ScompControlPlaneDiscoverRequest;
    response: ScompControlPlaneDiscoverResponse;
  };
  "__scomp.resolve": {
    request: ScompControlPlaneResolveRequest;
    response: ScompControlPlaneResolveResponse;
  };
  "__scomp.health": {
    request: ScompControlPlaneHealthRequest;
    response: ScompControlPlaneHealthResponse;
  };
}

export type ScompControlPlaneRequestPayload<Route extends ScompControlPlaneRoute> =
  ScompControlPlaneRouteContracts[Route]["request"];

export type ScompControlPlaneResponsePayload<Route extends ScompControlPlaneRoute> =
  ScompControlPlaneRouteContracts[Route]["response"];
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

export interface ScompTransportRequestEnvelope {
  id?: string;
  route: string;
  op: ScompTransportOperation;
  feed?: string;
  method?: string;
  payload?: unknown;
  meta?: ScompTransportMessageMeta;
}

export type ScompTransportRequest = ScompTransportRequestEnvelope;

export interface ScompTransportSuccessResponseEnvelope {
  id?: string;
  payload?: unknown;
  meta?: ScompTransportMessageMeta;
}

/** Structured error codes for programmatic error handling. */
export type ScompErrorCode =
  | "ROUTE_NOT_FOUND"
  | "SERVICE_NOT_FOUND"
  | "CONTROLLER_NOT_FOUND"
  | "FEED_NOT_FOUND"
  | "TIMEOUT"
  | "UNAUTHORIZED";

/** Array of all valid error codes for runtime validation. */
export const SCOMP_ERROR_CODES: ReadonlyArray<ScompErrorCode> = [
  "ROUTE_NOT_FOUND",
  "SERVICE_NOT_FOUND",
  "CONTROLLER_NOT_FOUND",
  "FEED_NOT_FOUND",
  "TIMEOUT",
  "UNAUTHORIZED",
] as const;

export interface ScompTransportErrorResponseEnvelope {
  id?: string;
  error: string;
  code?: ScompErrorCode;
  meta?: ScompTransportMessageMeta;
}

export type ScompTransportSuccessResponse = ScompTransportSuccessResponseEnvelope;

export type ScompTransportErrorResponse = ScompTransportErrorResponseEnvelope;

export type ScompTransportResponseEnvelope =
  | ScompTransportSuccessResponseEnvelope
  | ScompTransportErrorResponseEnvelope;

export type ScompTransportResponse = ScompTransportResponseEnvelope;

export type ScompControlPlaneRequestEnvelope<Route extends ScompControlPlaneRoute = ScompControlPlaneRoute> = Omit<
  ScompTransportRequestEnvelope,
  "route" | "op" | "payload"
> & {
  route: Route;
  op: "request";
  payload: ScompControlPlaneRequestPayload<Route>;
};

export type ScompControlPlaneSuccessResponseEnvelope<Route extends ScompControlPlaneRoute = ScompControlPlaneRoute> =
  Omit<ScompTransportSuccessResponseEnvelope, "payload"> & {
    payload: ScompControlPlaneResponsePayload<Route>;
  };

export type ScompControlPlaneRequest = {
  [Route in ScompControlPlaneRoute]: ScompControlPlaneRequestEnvelope<Route>;
}[ScompControlPlaneRoute];

export type ScompControlPlaneSuccessResponse = {
  [Route in ScompControlPlaneRoute]: ScompControlPlaneSuccessResponseEnvelope<Route>;
}[ScompControlPlaneRoute];

export type ScompFeedChunkType = "next" | "done" | "error";

export interface ScompFeedChunkEnvelope {
  channel: "feed";
  feed: string;
  type: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
  meta?: ScompTransportMessageMeta;
}

export type ScompFeedChunk = ScompFeedChunkEnvelope;

export interface ScompSerializer {
  stringify(value: unknown): string;
  parse<T = unknown>(text: string): T;
  contentType?: string;
}
