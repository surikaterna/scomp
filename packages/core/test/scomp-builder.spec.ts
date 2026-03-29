import assert from 'node:assert/strict';
import { createScompService } from '../src';

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
