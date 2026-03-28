import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CompiledRoute,
  type CompiledRouter
} from '@scomp/core';
import { WebSocketClientTransport } from '@scomp/transport-websocket-client';
import { WebSocketServerTransport } from '../src';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(iterable: AsyncIterable<number>): Promise<Array<number>> {
  const values: Array<number> = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

type Harness = {
  httpServer: HttpServer;
  url: string;
  serverTransport: WebSocketServerTransport;
};

async function createHarness(router: CompiledRouter): Promise<Harness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));

  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  const serverTransport = new WebSocketServerTransport({
    server: httpServer,
    outbound: { url }
  });
  await serverTransport.listen(router);

  return {
    httpServer,
    url,
    serverTransport
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('WebSocket transports', () => {
  it('supports request, signal, and feed end-to-end', async () => {
    const signals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      'math.double': {
        route: 'math.double',
        kind: 'request',
        handler: async (value: number) => value * 2
      },
      'math.notify': {
        route: 'math.notify',
        kind: 'signal',
        handler: async (payload: unknown) => {
          signals.push(payload);
        }
      },
      'math.count': {
        route: 'math.count',
        kind: 'feed',
        strategy: 'fanout',
        handler: async function* (limit: number) {
          for (let value = 1; value <= limit; value += 1) {
            yield value;
          }
        }
      }
    };

    const harness = await createHarness(router);
    const client = new WebSocketClientTransport({ url: harness.url });

    try {
      const requestResult = await client.request('math.double', 21);
      assert.equal(requestResult, 42);

      await client.signal('math.notify', { id: 7 });
      await wait(15);
      assert.deepEqual(signals, [{ id: 7 }]);

      const feedValues = await collect(client.feed('math.count', 3));
      assert.deepEqual(feedValues, [1, 2, 3]);
    } finally {
      await closeHarness(harness);
    }
  });

  it('shares fanout feeds by hash across subscribers', async () => {
    let feedStarts = 0;

    const router: Record<string, CompiledRoute> = {
      'prices.live': {
        route: 'prices.live',
        kind: 'feed',
        strategy: 'fanout',
        hashKey: (payload: unknown) => String((payload as { room: string }).room),
        handler: async function* () {
          feedStarts += 1;
          await wait(20);
          yield 1;
          await wait(10);
          yield 2;
          await wait(10);
          yield 3;
        }
      }
    };

    const harness = await createHarness(router);
    const clientA = new WebSocketClientTransport({ url: harness.url });
    const clientB = new WebSocketClientTransport({ url: harness.url });

    try {
      const [valuesA, valuesB] = await Promise.all([
        collect(clientA.feed('prices.live', { room: 'alpha' })),
        collect(clientB.feed('prices.live', { room: 'alpha' }))
      ]);

      assert.deepEqual(valuesA, [1, 2, 3]);
      assert.deepEqual(valuesB, [1, 2, 3]);
      assert.equal(feedStarts, 1);
    } finally {
      await closeHarness(harness);
    }
  });

  it('supports outbound request, signal, and feed from server transport', async () => {
    const signals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      'ops.echo': {
        route: 'ops.echo',
        kind: 'request',
        handler: async (payload: unknown) => ({ payload })
      },
      'ops.log': {
        route: 'ops.log',
        kind: 'signal',
        handler: async (payload: unknown) => {
          signals.push(payload);
        }
      },
      'ops.range': {
        route: 'ops.range',
        kind: 'feed',
        strategy: 'fanout',
        handler: async function* (limit: number) {
          for (let value = 1; value <= limit; value += 1) {
            yield value;
          }
        }
      }
    };

    const harness = await createHarness(router);

    try {
      const requestResult = await harness.serverTransport.request('ops.echo', { id: 11 });
      assert.deepEqual(requestResult, { payload: { id: 11 } });

      await harness.serverTransport.signal('ops.log', { line: 'hello' });
      await wait(15);
      assert.deepEqual(signals, [{ line: 'hello' }]);

      const values = await collect(harness.serverTransport.feed('ops.range', 2));
      assert.deepEqual(values, [1, 2]);
    } finally {
      await closeHarness(harness);
    }
  });
});
