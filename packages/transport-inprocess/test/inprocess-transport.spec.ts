import assert from 'node:assert/strict';
import {
  createScompClient,
  createScompFeed,
  createScompService
} from '@scomp/core';
import { createInprocessTransport } from '../src';

describe('createInprocessTransport', () => {
  it('supports request/response, feed streaming and fire-and-forget commands', async () => {
    const commands: Array<string> = [];

    const service = createScompService()
      .request('multiply', async (left: number, right: number) => left * right)
      .feed('countTo', async function* (limit: number) {
        for (let value = 1; value <= limit; value += 1) {
          yield value;
        }
      })
      .command('log', (message: string): void => {
        commands.push(message);
      })
      .build();

    const transport = createInprocessTransport(service);
    const client = createScompClient(service, transport);

    const requestResult = await client.multiply(4, 5);
    assert.equal(requestResult, 20);

    const feedResult: Array<number> = [];
    for await (const value of client.countTo(3)) {
      feedResult.push(value);
    }

    const commandResult = client.log('fire-and-forget');

    assert.equal(commandResult, undefined);
    assert.deepEqual(feedResult, [1, 2, 3]);
    assert.deepEqual(commands, ['fire-and-forget']);
  });

  it('keeps native ScompFeed responses as feed responses', async () => {
    const service = createScompService()
      .feed('watch', () => {
        const feed = createScompFeed<number>();
        queueMicrotask(() => {
          feed.next(7).next(8).complete();
        });
        return feed;
      })
      .build();

    const transport = createInprocessTransport(service);
    const client = createScompClient(service, transport);

    const values: Array<number> = [];
    for await (const value of client.watch()) {
      values.push(value);
    }

    assert.deepEqual(values, [7, 8]);
  });
});
