import assert from 'node:assert/strict';
import {
  SCOMP_CONTROL_PLANE_ROUTE_NAMES,
  createNodeLocalDiscoverHandler,
  createNodeLocalHealthHandler,
  createNodeLocalResolveHandler,
  composeRouterWithControlPlaneRoutes,
  createControlPlaneRouter,
  getControlPlaneRouteSecurityAdvice,
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

  it('resolves local routes and applies current-channel fallback', () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      }
    };

    const resolve = createNodeLocalResolveHandler(appRouter, {
      defaultTransport: 'websocket'
    });

    const direct = resolve({ route: 'users.getUser' });
    assert.deepEqual(direct, {
      resolved: true,
      fallbackUsed: false,
      endpoint: {
        route: 'users.getUser',
        channel: 'current-channel',
        transport: 'websocket'
      },
      candidates: [
        {
          route: 'users.getUser',
          channel: 'current-channel',
          transport: 'websocket'
        }
      ]
    });

    const withChannelHint = resolve({
      route: 'users.getUser',
      channel: 'ws:alternate'
    });
    assert.deepEqual(withChannelHint, {
      resolved: true,
      fallbackUsed: true,
      endpoint: {
        route: 'users.getUser',
        channel: 'current-channel',
        transport: 'websocket'
      },
      candidates: [
        {
          route: 'users.getUser',
          channel: 'ws:alternate',
          transport: 'websocket'
        },
        {
          route: 'users.getUser',
          channel: 'current-channel',
          transport: 'websocket'
        }
      ]
    });
  });

  it('returns unresolved for unknown routes and rejects invalid resolve input', () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      }
    };

    const resolve = createNodeLocalResolveHandler(appRouter);

    assert.deepEqual(resolve({ route: 'users.missing' }), {
      resolved: false,
      fallbackUsed: false,
      candidates: []
    });

    assert.throws(() => resolve({ route: '   ' }), /requires a route string/);
  });

  it('provides shallow and deep health responses with aggregated status', async () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      },
      'orders.list': {
        route: 'orders.list',
        kind: 'request',
        handler: async () => ([])
      }
    };

    const health = createNodeLocalHealthHandler(appRouter, {
      nodeId: 'node-health',
      now: () => new Date('2026-03-28T16:00:00.000Z'),
      checks: [
        async () => ({ name: 'users.db', status: 'ok' }),
        async () => ({ name: 'orders.replica', status: 'degraded', message: 'replica lag' })
      ]
    });

    const shallow = await health({ mode: 'shallow' });
    assert.deepEqual(shallow, {
      status: 'ok',
      checks: undefined,
      node: { id: 'node-health' },
      timestamp: '2026-03-28T16:00:00.000Z'
    });

    const deepVerbose = await health({ mode: 'deep', verbose: true });
    assert.equal(deepVerbose.status, 'degraded');
    assert.deepEqual(deepVerbose.checks, [
      {
        name: 'node.router',
        status: 'ok',
        message: 'Compiled routes available: 2'
      },
      {
        name: 'users.db',
        status: 'ok'
      },
      {
        name: 'orders.replica',
        status: 'degraded',
        message: 'replica lag'
      }
    ]);
  });

  it('filters deep health checks by target service when requested', async () => {
    const appRouter: CompiledRouter = {
      'users.getUser': {
        route: 'users.getUser',
        kind: 'request',
        handler: async () => ({ id: 1 })
      }
    };

    const health = createNodeLocalHealthHandler(appRouter, {
      nodeId: 'node-health',
      checks: [
        async () => ({ name: 'users.db', status: 'ok' }),
        async () => ({ name: 'orders.db', status: 'down' })
      ]
    });

    const usersOnly = await health({ mode: 'deep', verbose: true, service: 'users' });
    assert.equal(usersOnly.status, 'ok');
    assert.deepEqual(usersOnly.checks, [
      {
        name: 'users.db',
        status: 'ok'
      }
    ]);
  });

  it('returns explicit security posture guidance for control-plane routes', () => {
    const securityAdvice = getControlPlaneRouteSecurityAdvice();

    assert.deepEqual(securityAdvice, [
      {
        route: '__scomp.discover',
        defaultExposure: 'internal-only',
        requiredAuthorization: 'explicit-policy',
        recommendedScopes: ['scomp:control:discover'],
        notes: 'Discovery should be filtered to avoid leaking sensitive service topology.'
      },
      {
        route: '__scomp.resolve',
        defaultExposure: 'internal-only',
        requiredAuthorization: 'explicit-policy',
        recommendedScopes: ['scomp:control:resolve'],
        notes: 'Resolve responses should only include endpoint metadata required by the caller.'
      },
      {
        route: '__scomp.health',
        defaultExposure: 'internal-only',
        requiredAuthorization: 'explicit-policy',
        recommendedScopes: ['scomp:control:health'],
        notes: 'Default health output should remain minimal unless verbose checks are authorized.'
      }
    ]);
  });
});
