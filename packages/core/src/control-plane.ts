import {
  SCOMP_CONTROL_PLANE_NAMESPACE,
  type ScompControlPlaneDiscoverRequest,
  type ScompControlPlaneDiscoverResponse,
  type ScompControlPlaneHealthRequest,
  type ScompControlPlaneHealthResponse,
  type ScompControlPlaneResolveRequest,
  type ScompControlPlaneResolveResponse,
  type ScompControlPlaneRoute,
} from '@scomp/types';
import type { CompiledRoute, CompiledRouter } from './builder';

const CONTROL_PLANE_ROUTE_NAMES = {
  discover: '__scomp.discover',
  resolve: '__scomp.resolve',
  health: '__scomp.health'
} as const satisfies Record<'discover' | 'resolve' | 'health', ScompControlPlaneRoute>;

export interface ScompControlPlaneRouteHandlers {
  discover: (
    request: ScompControlPlaneDiscoverRequest
  ) => ScompControlPlaneDiscoverResponse | Promise<ScompControlPlaneDiscoverResponse>;
  resolve: (
    request: ScompControlPlaneResolveRequest
  ) => ScompControlPlaneResolveResponse | Promise<ScompControlPlaneResolveResponse>;
  health: (
    request: ScompControlPlaneHealthRequest
  ) => ScompControlPlaneHealthResponse | Promise<ScompControlPlaneHealthResponse>;
}

export interface NodeLocalDiscoverHandlerOptions {
  nodeId: string;
  ttlMs?: number;
  now?: () => Date;
  includeReservedRoutes?: boolean;
}

interface ServiceInventory {
  name: string;
  routes: Array<string>;
}

function parseControlPlanePayload<T extends object>(payload: unknown): T {
  if (payload === undefined) {
    return {} as T;
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Control-plane request payload must be an object.');
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
    kind: 'request',
    parser,
    handler
  };
}

function isReservedControlPlaneRoute(routeName: string): boolean {
  const reservedPrefix = `${SCOMP_CONTROL_PLANE_NAMESPACE}.`;
  return routeName === SCOMP_CONTROL_PLANE_NAMESPACE || routeName.startsWith(reservedPrefix);
}

function toServiceName(routeName: string): string {
  const [serviceName] = routeName.split('.');
  return serviceName || 'default';
}

function buildServiceInventory(
  router: CompiledRouter,
  includeReservedRoutes: boolean,
): Array<ServiceInventory> {
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
      routes: [...new Set(routes)].sort((left, right) => left.localeCompare(right))
    }));
}

export function createNodeLocalDiscoverHandler(
  appRouter: CompiledRouter,
  options: NodeLocalDiscoverHandlerOptions,
): (request: ScompControlPlaneDiscoverRequest) => ScompControlPlaneDiscoverResponse {
  const {
    nodeId,
    ttlMs = 1000,
    now = () => new Date(),
    includeReservedRoutes = false
  } = options;

  return (request) => {
    const servicePrefix = request.servicePrefix?.trim();
    const includeRoutes = request.includeRoutes === true;
    const services = buildServiceInventory(appRouter, includeReservedRoutes)
      .filter((service) => !servicePrefix || service.name.startsWith(servicePrefix))
      .map((service) => includeRoutes
        ? { name: service.name, routes: service.routes }
        : { name: service.name });

    return {
      services,
      node: { id: nodeId },
      generatedAt: now().toISOString(),
      ttlMs
    };
  };
}

export function createControlPlaneRouter(
  handlers: ScompControlPlaneRouteHandlers,
): CompiledRouter {
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
    )
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
    ...appRouter
  };

  for (const [routeName, route] of Object.entries(controlPlaneRouter)) {
    if (composed[routeName]) {
      throw new Error(`Control-plane route collides with existing route: ${routeName}`);
    }

    composed[routeName] = route;
  }

  return composed;
}

export {
  CONTROL_PLANE_ROUTE_NAMES as SCOMP_CONTROL_PLANE_ROUTE_NAMES
};
