import assert from 'node:assert/strict';
import {
  SCOMP_CONTROL_PLANE_ROUTE_NAMES,
  composeRouterWithControlPlaneRoutes,
  createControlPlaneRouter,
  type CompiledRouter,
  type ScompControlPlaneRouteHandlers
} from '../src';

function createHandlers(): ScompControlPlaneRouteHandlers {
  return {
    discover: async (request) => ({
      services: request.includeRoutes
        ? [{ name: 'users', routes: ['users.getUser'] }]
        : [{ name: 'users' }],
      node: { id: 'node-a' }
    }),
    resolve: async (request) => ({
      resolved: request.route === 'users.getUser',
      fallbackUsed: true,
      endpoint: {
        route: request.route,
        channel: request.channel ?? 'ws:default',
        transport: 'websocket'
      }
    }),
    health: async (request) => ({
      status: 'ok',
      checks: request.verbose
        ? [{ name: 'router', status: 'ok' }]
        : undefined,
      node: { id: 'node-a' }
    })
  };
}

describe('control-plane router composition', () => {
  it('creates deterministic request routes for control-plane operations', async () => {
    const router = createControlPlaneRouter(createHandlers());

    assert.deepEqual(Object.keys(router).sort(), [
      SCOMP_CONTROL_PLANE_ROUTE_NAMES.discover,
      SCOMP_CONTROL_PLANE_ROUTE_NAMES.health,
      SCOMP_CONTROL_PLANE_ROUTE_NAMES.resolve
    ]);

    for (const route of Object.values(router)) {
      assert.equal(route.kind, 'request');
    }

    const discover = router[SCOMP_CONTROL_PLANE_ROUTE_NAMES.discover];
    const discoverResult = await (discover.handler(
      discover.parser?.({ includeRoutes: true }) ?? {}
    ) as Promise<unknown>);
    assert.deepEqual(discoverResult, {
      services: [{ name: 'users', routes: ['users.getUser'] }],
      node: { id: 'node-a' }
    });
  });

  it('composes application and control-plane routers without mutating input', () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      }
    };

    const composed = composeRouterWithControlPlaneRoutes(appRouter, createHandlers());

    assert.equal(appRouter[SCOMP_CONTROL_PLANE_ROUTE_NAMES.discover], undefined);
    assert.equal(composed['users.getUser'], appRouter['users.getUser']);
    assert.ok(composed[SCOMP_CONTROL_PLANE_ROUTE_NAMES.discover]);
    assert.ok(composed[SCOMP_CONTROL_PLANE_ROUTE_NAMES.resolve]);
    assert.ok(composed[SCOMP_CONTROL_PLANE_ROUTE_NAMES.health]);
  });

  it('rejects reserved namespace usage in application routes', () => {
    const appRouter: CompiledRouter = {
      '__scomp.custom': {
        route: '__scomp.custom',
        kind: 'request',
        handler: async () => undefined
      }
    };

    assert.throws(
      () => composeRouterWithControlPlaneRoutes(appRouter, createHandlers()),
      /reserved for control-plane routes/
    );
  });

  it('rejects non-object control-plane payloads', () => {
    const router = createControlPlaneRouter(createHandlers());

    assert.throws(
      () => router[SCOMP_CONTROL_PLANE_ROUTE_NAMES.resolve].parser?.('invalid'),
      /payload must be an object/
    );
  });
});
