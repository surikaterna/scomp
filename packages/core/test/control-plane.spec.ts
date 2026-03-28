import assert from 'node:assert/strict';
import {
  SCOMP_CONTROL_PLANE_ROUTE_NAMES,
  createNodeLocalDiscoverHandler,
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

  it('builds node-local discover inventory with filters and metadata', () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      },
      'users.list': {
        route: 'users.list',
        kind: 'request',
        handler: async () => ([])
      },
      'orders.list': {
        route: 'orders.list',
        kind: 'request',
        handler: async () => ([])
      },
      '__scomp.health': {
        route: '__scomp.health',
        kind: 'request',
        handler: async () => ({ status: 'ok' })
      }
    };

    const discover = createNodeLocalDiscoverHandler(appRouter, {
      nodeId: 'node-x',
      ttlMs: 1500,
      now: () => new Date('2026-03-28T15:00:00.000Z')
    });

    const withoutRoutes = discover({ servicePrefix: 'us' });
    assert.deepEqual(withoutRoutes, {
      services: [{ name: 'users' }],
      node: { id: 'node-x' },
      generatedAt: '2026-03-28T15:00:00.000Z',
      ttlMs: 1500
    });

    const withRoutes = discover({ includeRoutes: true });
    assert.deepEqual(withRoutes.services, [
      { name: 'orders', routes: ['orders.list'] },
      { name: 'users', routes: ['users.getUser', 'users.list'] }
    ]);
  });
});
