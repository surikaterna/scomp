import assert from 'node:assert/strict';
import {
  ScompFeed,
  createScompFeed,
  fromGenerator,
  fromLegacyObservable,
  type LegacyObservableLike
} from '../src';

describe('ScompFeed', () => {
  it('supports legacy handler chaining and completion', () => {
    const feed = createScompFeed<number>();
    let total = 0;
    let completed = false;

    feed
      .onNext((value) => {
        total += value;
      })
      .onComplete(() => {
        completed = true;
      })
      .next(1)
      .next(2)
      .complete();

    assert.equal(total, 3);
    assert.equal(completed, true);
    assert.equal(feed.isUnsubscribed(), false);
  });

  it('supports generator consumption through async iteration', async () => {
    const feed = fromGenerator(function* numbers() {
      yield 1;
      yield 2;
      yield 3;
    });

    const received: Array<number> = [];
    for await (const value of feed) {
      received.push(value);
    }

    assert.deepEqual(received, [1, 2, 3]);
  });

  it('propagates errors to async iterators', async () => {
    const feed = createScompFeed<number>();
    const iterator = feed[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    const error = new Error('boom');
    feed.error(error);

    await assert.rejects(pendingNext, /boom/);
  });

  it('can adapt legacy observable-like sources and forward unsubscribe', async () => {
    class LegacyObservableStub implements LegacyObservableLike<number> {
      private _onNext?: (res: number) => void;
      private _onError?: (err: Error) => void;
      private _onComplete?: (res: unknown) => void;
      public unsubscribed = false;

      onNext(fn: (res: number) => void) {
        this._onNext = fn;
        return this;
      }

      onError(fn: (err: Error) => void) {
        this._onError = fn;
        return this;
      }

      onComplete(fn: (res: unknown) => void) {
        this._onComplete = fn;
        return this;
      }

      unsubscribe() {
        this.unsubscribed = true;
      }

      emit(value: number) {
        this._onNext?.(value);
      }

      fail(error: Error) {
        this._onError?.(error);
      }

      finish(value?: unknown) {
        this._onComplete?.(value);
      }
    }

    const legacy = new LegacyObservableStub();
    const feed = fromLegacyObservable(legacy);
    const received: Array<number> = [];

    const consume = (async () => {
      for await (const value of feed) {
        received.push(value);
        if (value === 2) {
          feed.unsubscribe();
        }
      }
    })();

    legacy.emit(1);
    legacy.emit(2);

    await consume;
    assert.deepEqual(received, [1, 2]);
    assert.equal(legacy.unsubscribed, true);
  });

  it('unifies teardown when async iteration is broken early', async () => {
    const feed = createScompFeed<number>();
    let unsubscribed = false;
    feed.onUnsubscribe(() => {
      unsubscribed = true;
    });

    const consume = (async () => {
      const values: Array<number> = [];
      for await (const value of feed) {
        values.push(value);
        break;
      }
      return values;
    })();

    feed.next(10).next(20);
    const values = await consume;

    assert.deepEqual(values, [10]);
    assert.equal(unsubscribed, true);
    assert.equal(feed.isUnsubscribed(), true);
  });

  it('bridges an async source iterable via constructor', async () => {
    const source = (async function* () {
      yield 3;
      yield 4;
    })();

    const feed = new ScompFeed<number>(source);
    const values: Array<number> = [];

    for await (const value of feed) {
      values.push(value);
    }

    assert.deepEqual(values, [3, 4]);
  });
});
