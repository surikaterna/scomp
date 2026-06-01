import {
  SCOMP_CONTROL_PLANE_NAMESPACE,
  type ScompControlPlaneDiscoverRequest,
  type ScompControlPlaneDiscoverResponse,
  type ScompControlPlaneHealthRequest,
  type ScompControlPlaneHealthResponse,
  type ScompControlPlaneResolveRequest,
  type ScompControlPlaneResolveResponse,
  type ScompControlPlaneRoute,
} from "@scompr/types";
import type { CompiledRoute, CompiledRouter } from "./builder";

const CONTROL_PLANE_ROUTE_NAMES = {
  discover: "__scomp.discover",
  resolve: "__scomp.resolve",
  health: "__scomp.health",
} as const satisfies Record<"discover" | "resolve" | "health", ScompControlPlaneRoute>;

export interface ScompControlPlaneRouteHandlers {
  discover: (
    request: ScompControlPlaneDiscoverRequest,
  ) => ScompControlPlaneDiscoverResponse | Promise<ScompControlPlaneDiscoverResponse>;
  resolve: (
    request: ScompControlPlaneResolveRequest,
  ) => ScompControlPlaneResolveResponse | Promise<ScompControlPlaneResolveResponse>;
  health: (
    request: ScompControlPlaneHealthRequest,
  ) => ScompControlPlaneHealthResponse | Promise<ScompControlPlaneHealthResponse>;
}

export interface NodeLocalDiscoverHandlerOptions {
  nodeId: string;
  ttlMs?: number;
  now?: () => Date;
  includeReservedRoutes?: boolean;
}

export interface NodeLocalResolveHandlerOptions {
  defaultTransport?: string;
  includeReservedRoutes?: boolean;
}

export interface NodeLocalHealthCheckResult {
  name: string;
  status: "ok" | "degraded" | "down";
  message?: string;
}

export interface NodeLocalHealthHandlerContext {
  router: CompiledRouter;
  request: ScompControlPlaneHealthRequest;
}

export interface NodeLocalHealthHandlerOptions {
  nodeId: string;
  now?: () => Date;
  checks?: Array<
    (context: NodeLocalHealthHandlerContext) => NodeLocalHealthCheckResult | Promise<NodeLocalHealthCheckResult>
  >;
}

export interface ControlPlaneRouteSecurityAdvice {
  route: ScompControlPlaneRoute;
  defaultExposure: "internal-only";
  requiredAuthorization: "explicit-policy";
  recommendedScopes: Array<string>;
  notes: string;
}

interface ServiceInventory {
  name: string;
  routes: Array<string>;
}

function parseControlPlanePayload<T extends object>(payload: unknown): T {
  if (payload === undefined) {
    return {} as T;
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Control-plane request payload must be an object.");
  }

  return payload as T;
}

function toRequestRoute(
  route: ScompControlPlaneRoute,
  parser: (payload: unknown) => unknown,
  handler: (payload: unknown) => unknown,
): CompiledRoute {
  return {
    route,
    kind: "request",
    parser,
    handler,
  };
}

function isReservedControlPlaneRoute(routeName: string): boolean {
  const reservedPrefix = `${SCOMP_CONTROL_PLANE_NAMESPACE}.`;
  return routeName === SCOMP_CONTROL_PLANE_NAMESPACE || routeName.startsWith(reservedPrefix);
}

function toServiceName(routeName: string): string {
  const [serviceName] = routeName.split(".");
  return serviceName || "default";
}

function buildServiceInventory(router: CompiledRouter, includeReservedRoutes: boolean): Array<ServiceInventory> {
  const services = new Map<string, Array<string>>();

  for (const route of Object.values(router)) {
    const routeName = route.route;
    if (!includeReservedRoutes && isReservedControlPlaneRoute(routeName)) {
      continue;
    }

    const serviceName = toServiceName(routeName);
    const serviceRoutes = services.get(serviceName) ?? [];
    serviceRoutes.push(routeName);
    services.set(serviceName, serviceRoutes);
  }

  return Array.from(services.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, routes]) => ({
      name,
      routes: [...new Set(routes)].sort((left, right) => left.localeCompare(right)),
    }));
}

export function createNodeLocalDiscoverHandler(
  appRouter: CompiledRouter,
  options: NodeLocalDiscoverHandlerOptions,
): (request: ScompControlPlaneDiscoverRequest) => ScompControlPlaneDiscoverResponse {
  const { nodeId, ttlMs = 1000, now = () => new Date(), includeReservedRoutes = false } = options;

  return (request) => {
    const servicePrefix = request.servicePrefix?.trim();
    const includeRoutes = request.includeRoutes === true;
    const services = buildServiceInventory(appRouter, includeReservedRoutes)
      .filter((service) => !servicePrefix || service.name.startsWith(servicePrefix))
      .map((service) => (includeRoutes ? { name: service.name, routes: service.routes } : { name: service.name }));

    return {
      services,
      node: { id: nodeId },
      generatedAt: now().toISOString(),
      ttlMs,
    };
  };
}

function hasRoute(router: CompiledRouter, routeName: string, includeReservedRoutes: boolean): boolean {
  const route = router[routeName];
  if (!route) {
    return false;
  }

  if (!includeReservedRoutes && isReservedControlPlaneRoute(route.route)) {
    return false;
  }

  return true;
}

function buildCandidateChannels(requestedChannel?: string): Array<string> {
  const normalizedRequestedChannel = requestedChannel?.trim();
  if (!normalizedRequestedChannel) {
    return ["current-channel"];
  }

  return [normalizedRequestedChannel, "current-channel"];
}

function aggregateHealthStatus(checks: Array<NodeLocalHealthCheckResult>): "ok" | "degraded" | "down" {
  if (checks.some((check) => check.status === "down")) {
    return "down";
  }

  if (checks.some((check) => check.status === "degraded")) {
    return "degraded";
  }

  return "ok";
}

function isCheckRelevantForService(checkName: string, serviceName?: string): boolean {
  if (!serviceName) {
    return true;
  }

  return checkName === serviceName || checkName.startsWith(`${serviceName}.`);
}

function createDefaultHealthChecks(router: CompiledRouter): Array<NodeLocalHealthCheckResult> {
  const routeCount = Object.keys(router).length;
  return [
    {
      name: "node.router",
      status: routeCount > 0 ? "ok" : "degraded",
      message:
        routeCount > 0 ? `Compiled routes available: ${routeCount}` : "No compiled routes were found on this node.",
    },
  ];
}

export function createNodeLocalHealthHandler(
  appRouter: CompiledRouter,
  options: NodeLocalHealthHandlerOptions,
): (request: ScompControlPlaneHealthRequest) => Promise<ScompControlPlaneHealthResponse> {
  const { nodeId, now = () => new Date(), checks = [] } = options;

  return async (request) => {
    const mode = request.mode ?? "shallow";
    const shouldIncludeChecks = request.verbose === true;
    const baseChecks = createDefaultHealthChecks(appRouter);

    let executedChecks = baseChecks;
    if (mode === "deep" && checks.length > 0) {
      const customChecks = await Promise.all(
        checks.map((runCheck) =>
          runCheck({
            router: appRouter,
            request,
          }),
        ),
      );
      executedChecks = [...baseChecks, ...customChecks];
    }

    const filteredChecks = executedChecks.filter((check) => isCheckRelevantForService(check.name, request.service));
    const status = aggregateHealthStatus(filteredChecks);

    return {
      status,
      checks: shouldIncludeChecks ? filteredChecks : undefined,
      node: { id: nodeId },
      timestamp: now().toISOString(),
    };
  };
}

export function createNodeLocalResolveHandler(
  appRouter: CompiledRouter,
  options: NodeLocalResolveHandlerOptions = {},
): (request: ScompControlPlaneResolveRequest) => ScompControlPlaneResolveResponse {
  const { defaultTransport, includeReservedRoutes = false } = options;

  return (request) => {
    const routeName = request.route?.trim();
    if (!routeName) {
      throw new Error("Resolve request requires a route string.");
    }

    if (!hasRoute(appRouter, routeName, includeReservedRoutes)) {
      return {
        resolved: false,
        fallbackUsed: false,
        candidates: [],
      };
    }

    const channelCandidates = buildCandidateChannels(request.channel);
    const candidates = channelCandidates.map((channelName) => ({
      route: routeName,
      channel: channelName,
      transport: defaultTransport,
    }));

    const preferred = candidates[0];
    const fallback = candidates.find((candidate) => candidate.channel === "current-channel") ?? preferred;
    const fallbackUsed = Boolean(request.channel?.trim()) && fallback.channel === "current-channel";

    return {
      resolved: true,
      fallbackUsed,
      endpoint: fallbackUsed ? fallback : preferred,
      candidates,
    };
  };
}

export function createControlPlaneRouter(handlers: ScompControlPlaneRouteHandlers): CompiledRouter {
  return {
    [CONTROL_PLANE_ROUTE_NAMES.discover]: toRequestRoute(
      CONTROL_PLANE_ROUTE_NAMES.discover,
      (payload) => parseControlPlanePayload<ScompControlPlaneDiscoverRequest>(payload),
      (payload) => handlers.discover(payload as ScompControlPlaneDiscoverRequest),
    ),
    [CONTROL_PLANE_ROUTE_NAMES.resolve]: toRequestRoute(
      CONTROL_PLANE_ROUTE_NAMES.resolve,
      (payload) => parseControlPlanePayload<ScompControlPlaneResolveRequest>(payload),
      (payload) => handlers.resolve(payload as ScompControlPlaneResolveRequest),
    ),
    [CONTROL_PLANE_ROUTE_NAMES.health]: toRequestRoute(
      CONTROL_PLANE_ROUTE_NAMES.health,
      (payload) => parseControlPlanePayload<ScompControlPlaneHealthRequest>(payload),
      (payload) => handlers.health(payload as ScompControlPlaneHealthRequest),
    ),
  };
}

function assertNoReservedNamespaceRoutes(router: CompiledRouter): void {
  for (const routeName of Object.keys(router)) {
    if (isReservedControlPlaneRoute(routeName)) {
      throw new Error(`Route namespace is reserved for control-plane routes: ${routeName}`);
    }
  }
}

export function composeRouterWithControlPlaneRoutes(
  appRouter: CompiledRouter,
  handlers: ScompControlPlaneRouteHandlers,
): CompiledRouter {
  assertNoReservedNamespaceRoutes(appRouter);

  const controlPlaneRouter = createControlPlaneRouter(handlers);
  const composed: CompiledRouter = {
    ...appRouter,
  };

  for (const [routeName, route] of Object.entries(controlPlaneRouter)) {
    if (composed[routeName]) {
      throw new Error(`Control-plane route collides with existing route: ${routeName}`);
    }

    composed[routeName] = route;
  }

  return composed;
}

export function getControlPlaneRouteSecurityAdvice(): Array<ControlPlaneRouteSecurityAdvice> {
  return [
    {
      route: CONTROL_PLANE_ROUTE_NAMES.discover,
      defaultExposure: "internal-only",
      requiredAuthorization: "explicit-policy",
      recommendedScopes: ["scomp:control:discover"],
      notes: "Discovery should be filtered to avoid leaking sensitive service topology.",
    },
    {
      route: CONTROL_PLANE_ROUTE_NAMES.resolve,
      defaultExposure: "internal-only",
      requiredAuthorization: "explicit-policy",
      recommendedScopes: ["scomp:control:resolve"],
      notes: "Resolve responses should only include endpoint metadata required by the caller.",
    },
    {
      route: CONTROL_PLANE_ROUTE_NAMES.health,
      defaultExposure: "internal-only",
      requiredAuthorization: "explicit-policy",
      recommendedScopes: ["scomp:control:health"],
      notes: "Default health output should remain minimal unless verbose checks are authorized.",
    },
  ];
}

export { CONTROL_PLANE_ROUTE_NAMES as SCOMP_CONTROL_PLANE_ROUTE_NAMES };
