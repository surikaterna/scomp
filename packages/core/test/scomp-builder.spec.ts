import assert from 'node:assert/strict';
import {
  composeScompFragments,
  createNodeLocalDiscoverHandler,
  createNodeLocalResolveHandler,
  createScompFragment,
  createScompService
} from '../src';

describe('createScompService contract builder', () => {
  it('supports grouped requests/signals/feeds authoring with deterministic route kinds', async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const service = createScompService<UsersContract>('users').implement({
      requests: {
        getUser: {
          parser: (payload): { id: number } => {
            const value = payload as { id: number };
            return { id: Number(value.id) };
          },
          handler: async (input) => ({ id: input.id, name: `u-${input.id}` })
        }
      },
      signals: {
        notifyLogin: {
          parser: (payload): { id: number } => {
            const value = payload as { id: number };
            return { id: Number(value.id) };
          },
          handler: async () => {
            return;
          }
        }
      },
      feeds: {
        liveUsers: {
          strategy: 'fanout',
          hashKey: (input) => input.room,
          backpressure: { highWaterMark: 8 },
          handler: async function* () {
            yield { id: 1 };
          }
        }
      }
    });

    const getUserRoute = service.router['users.getUser'];
    const signalRoute = service.router['users.notifyLogin'];
    const liveRoute = service.router['users.liveUsers'];

    assert.equal(getUserRoute.kind, 'request');
    assert.equal(signalRoute.kind, 'signal');
    assert.equal(liveRoute.kind, 'feed');
    assert.equal(liveRoute.strategy, 'fanout');
    assert.equal(liveRoute.backpressure?.highWaterMark, 8);
    assert.equal(typeof liveRoute.hashKey, 'function');

    const getUserResult = await (getUserRoute.handler(getUserRoute.parser?.({ id: '9' }) ?? { id: 0 }) as Promise<{ id: number; name: string }>);
    assert.deepEqual(getUserResult, { id: 9, name: 'u-9' });

    const liveIterator = (liveRoute.handler({ room: 'general' }) as AsyncIterable<{ id: number }>)[Symbol.asyncIterator]();
    const firstChunk = await liveIterator.next();
    assert.deepEqual(firstChunk, { value: { id: 1 }, done: false });
  });

  it('keeps grouped route kind deterministic even if method configs include conflicting kinds', () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const service = createScompService<UsersContract>('users').implement({
      requests: {
        getUser: {
          kind: 'feed',
          handler: async (input: { id: number }) => ({ id: input.id })
        } as unknown as (input: { id: number }) => Promise<{ id: number }>
      },
      signals: {
        notifyLogin: {
          kind: 'request',
          handler: async () => {
            return;
          }
        } as unknown as (input: { id: number }) => Promise<void>
      },
      feeds: {
        liveUsers: {
          kind: 'signal',
          strategy: 'exclusive',
          handler: async function* () {
            yield { id: 1 };
          }
        } as unknown as (input: { room: string }) => AsyncIterable<{ id: number }>
      }
    });

    assert.equal(service.router['users.getUser'].kind, 'request');
    assert.equal(service.router['users.notifyLogin'].kind, 'signal');
    assert.equal(service.router['users.liveUsers'].kind, 'feed');
  });

  it('compiles request, signal, and feed methods into a flat routing table', async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const service = createScompService<UsersContract>('users').implement({
      getUser: {
        kind: 'request',
        parser: (payload): { id: number } => {
          const value = payload as { id: number };
          return { id: Number(value.id) };
        },
        handler: async (input) => ({ id: input.id, name: `u-${input.id}` })
      },
      notifyLogin: {
        kind: 'signal',
        parser: (payload): { id: number } => {
          const value = payload as { id: number };
          return { id: Number(value.id) };
        },
        handler: async () => {
          return;
        }
      },
      liveUsers: {
        kind: 'feed',
        strategy: 'fanout',
        hashKey: (input) => input.room,
        backpressure: { highWaterMark: 8 },
        handler: async function* () {
          yield { id: 1 };
        }
      }
    });

    const getUserRoute = service.router['users.getUser'];
    const signalRoute = service.router['users.notifyLogin'];
    const liveRoute = service.router['users.liveUsers'];

    assert.equal(service.name, 'users');
    assert.equal(getUserRoute.kind, 'request');
    assert.equal(signalRoute.kind, 'signal');
    assert.equal(liveRoute.kind, 'feed');
    assert.equal(liveRoute.strategy, 'fanout');
    assert.equal(liveRoute.backpressure?.highWaterMark, 8);
    assert.equal(typeof liveRoute.hashKey, 'function');

    const getUserResult = await (getUserRoute.handler(getUserRoute.parser?.({ id: '9' }) ?? { id: 0 }) as Promise<{ id: number; name: string }>);
    assert.deepEqual(getUserResult, { id: 9, name: 'u-9' });

    const liveIterator = (liveRoute.handler({ room: 'general' }) as AsyncIterable<{ id: number }>)[Symbol.asyncIterator]();
    const firstChunk = await liveIterator.next();
    assert.deepEqual(firstChunk, { value: { id: 1 }, done: false });
  });

  it('supports raw function handlers and defaults inferred request route kind', async () => {
    interface CalculatorContract {
      sum(input: { left: number; right: number }): Promise<number>;
    }

    const service = createScompService<CalculatorContract>('math').implement({
      sum: async ({ left, right }) => left + right
    });

    const route = service.router['math.sum'];
    assert.equal(route.kind, 'request');
    const result = await (route.handler({ left: 2, right: 5 }) as Promise<number>);
    assert.equal(result, 7);
  });
});

describe('createScompFragment contract builder', () => {
  it('supports grouped partial fragment authoring with deterministic route kinds', async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const fragment = createScompFragment<UsersContract>('users').implement({
      requests: {
        getUser: async ({ id }) => ({ id, name: `u-${id}` })
      },
      feeds: {
        liveUsers: {
          strategy: 'exclusive',
          handler: async function* () {
            yield { id: 1 };
          }
        }
      }
    });

    assert.equal(fragment.name, 'users');
    assert.equal(fragment.router['users.getUser'].kind, 'request');
    assert.equal(fragment.router['users.liveUsers'].kind, 'feed');
    assert.equal(fragment.router['users.notifyLogin'], undefined);

    const getUserResult = await (fragment.router['users.getUser'].handler({ id: 7 }) as Promise<{ id: number; name: string }>);
    assert.deepEqual(getUserResult, { id: 7, name: 'u-7' });
  });

  it('supports flat partial fragment authoring', async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const fragment = createScompFragment<UsersContract>('users').implement({
      notifyLogin: {
        kind: 'signal',
        handler: async () => {
          return;
        }
      }
    });

    assert.equal(fragment.router['users.notifyLogin'].kind, 'signal');
    await fragment.router['users.notifyLogin'].handler({ id: 99 });
    assert.equal(fragment.router['users.getUser'], undefined);
  });

  it('composes fragments without overriding methods', async () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const requestsFragment = createScompFragment<UsersContract>('users').implement({
      requests: {
        getUser: async ({ id }) => ({ id, name: `u-${id}` })
      }
    });

    const signalsFragment = createScompFragment<UsersContract>('users').implement({
      signals: {
        notifyLogin: async () => {
          return;
        }
      }
    });

    const composed = composeScompFragments(requestsFragment, signalsFragment);

    assert.equal(composed.router['users.getUser'].kind, 'request');
    assert.equal(composed.router['users.notifyLogin'].kind, 'signal');
  });

  it('composed fragment router remains compatible with discover/resolve control-plane handlers', () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
      notifyLogin(input: { id: number }): Promise<void>;
      liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
    }

    const requestsFragment = createScompFragment<UsersContract>('users').implement({
      requests: {
        getUser: async ({ id }) => ({ id, name: `u-${id}` })
      }
    });

    const signalsFragment = createScompFragment<UsersContract>('users').implement({
      signals: {
        notifyLogin: async () => {
          return;
        }
      }
    });

    const feedsFragment = createScompFragment<UsersContract>('users').implement({
      feeds: {
        liveUsers: {
          strategy: 'fanout',
          handler: async function* () {
            yield { id: 1 };
          }
        }
      }
    });

    const composed = composeScompFragments(requestsFragment, signalsFragment, feedsFragment);
    const discover = createNodeLocalDiscoverHandler(composed.router, {
      nodeId: 'node-1'
    });
    const resolve = createNodeLocalResolveHandler(composed.router, {
      defaultTransport: 'inproc'
    });

    const discovered = discover({ includeRoutes: true });
    assert.deepEqual(discovered.services, [
      {
        name: 'users',
        routes: ['users.getUser', 'users.liveUsers', 'users.notifyLogin']
      }
    ]);

    const resolved = resolve({ route: 'users.notifyLogin', channel: 'alpha' });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.fallbackUsed, true);
    assert.deepEqual(resolved.endpoint, {
      route: 'users.notifyLogin',
      channel: 'current-channel',
      transport: 'inproc'
    });
    assert.deepEqual(resolved.candidates, [
      {
        route: 'users.notifyLogin',
        channel: 'alpha',
        transport: 'inproc'
      },
      {
        route: 'users.notifyLogin',
        channel: 'current-channel',
        transport: 'inproc'
      }
    ]);
  });

  it('rejects duplicate methods when composing fragments', () => {
    interface UsersContract {
      getUser(input: { id: number }): Promise<{ id: number; name: string }>;
    }

    const first = createScompFragment<UsersContract>('users').implement({
      requests: {
        getUser: async ({ id }) => ({ id, name: `a-${id}` })
      }
    });

    const second = createScompFragment<UsersContract>('users').implement({
      requests: {
        getUser: async ({ id }) => ({ id, name: `b-${id}` })
      }
    });

    assert.throws(
      () => composeScompFragments(first as never, second as never),
      /Duplicate method "getUser" defined by fragments users#1 \(users.getUser\) and users#2 \(users.getUser\)/
    );
  });
});
