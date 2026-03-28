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
  const reservedPrefix = `${SCOMP_CONTROL_PLANE_NAMESPACE}.`;

  for (const routeName of Object.keys(router)) {
    if (routeName === SCOMP_CONTROL_PLANE_NAMESPACE || routeName.startsWith(reservedPrefix)) {
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
