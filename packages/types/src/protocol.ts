export type ScompTransportOperation =
  | "request"
  | "signal"
  | "feed_start"
  | "feed_stop";

export const SCOMP_CONTROL_PLANE_NAMESPACE = "__scomp";

export type ScompControlPlaneRoute =
  | "__scomp.discover"
  | "__scomp.resolve"
  | "__scomp.health";

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

export type ScompControlPlaneRequestPayload<
  Route extends ScompControlPlaneRoute,
> = ScompControlPlaneRouteContracts[Route]["request"];

export type ScompControlPlaneResponsePayload<
  Route extends ScompControlPlaneRoute,
> = ScompControlPlaneRouteContracts[Route]["response"];

export interface ScompTransportMessageMeta {
  auth?: unknown;
  traceId?: string;
  tenantId?: string;
  tags?: Record<string, string>;
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

export type ScompControlPlaneRequestEnvelope<
  Route extends ScompControlPlaneRoute = ScompControlPlaneRoute,
> = Omit<ScompTransportRequestEnvelope, "route" | "op" | "payload"> & {
  route: Route;
  op: "request";
  payload: ScompControlPlaneRequestPayload<Route>;
};

export type ScompControlPlaneSuccessResponseEnvelope<
  Route extends ScompControlPlaneRoute = ScompControlPlaneRoute,
> = Omit<ScompTransportSuccessResponseEnvelope, "payload"> & {
  payload: ScompControlPlaneResponsePayload<Route>;
};

export type ScompControlPlaneRequest = {
  [Route in ScompControlPlaneRoute]: ScompControlPlaneRequestEnvelope<Route>;
}[ScompControlPlaneRoute];

export type ScompControlPlaneSuccessResponse = {
  [Route in ScompControlPlaneRoute]:
    ScompControlPlaneSuccessResponseEnvelope<Route>;
}[ScompControlPlaneRoute];

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
  hash?: ScompFeedHashFunction;
}

export type ScompFeedHashFunction = (value: string) => string;

export function createRuntimeNeutralFeedHasher(): ScompFeedHashFunction {
  return (value: string): string => {
    const normalized = String(value);
    const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d];

    const chunks = seeds.map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }

      return hash.toString(16).padStart(8, "0");
    });

    return chunks.join("").slice(0, 32);
  };
}

const defaultFeedHasher = createRuntimeNeutralFeedHasher();

function normalizeHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Feed hash function returned an empty hash value.");
  }

  if (normalized.length >= 32) {
    return normalized.slice(0, 32);
  }

  return normalized.padEnd(32, "0");
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
  const hash = (options.hash ?? defaultFeedHasher)(`${route}:${serialized}`);
  return normalizeHash(hash);
}

export interface ScompSerializer {
  stringify(value: unknown): string;
  parse<T = unknown>(text: string): T;
  contentType?: string;
}
