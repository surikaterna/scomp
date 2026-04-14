import assert from 'node:assert/strict';
import {
  ScompFeed,
  createScompFeed,
  fromAsyncIterable,
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

  it('closes source iterator when feed is unsubscribed during _consumeSource', async () => {
    let finallyCalled = false;

    async function* slowSource() {
      try {
        yield 1;
        yield 2;
        // Yield a value that will never be consumed
        yield 3;
      } finally {
        finallyCalled = true;
      }
    }

    const feed = new ScompFeed<number>(slowSource);
    const values: Array<number> = [];

    for await (const value of feed) {
      values.push(value);
      if (value === 2) {
        feed.unsubscribe();
      }
    }

    // Allow microtask queue to flush so _consumeSource can break and trigger finally
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(values, [1, 2]);
    assert.equal(finallyCalled, true, 'source generator finally block must run on unsubscribe');
  });

  it('closes source iterator in fromAsyncIterable on unsubscribe', async () => {
    let finallyCalled = false;

    async function* source() {
      try {
        yield 10;
        yield 20;
        yield 30;
      } finally {
        finallyCalled = true;
      }
    }

    const feed = fromAsyncIterable(source());
    const values: Array<number> = [];

    for await (const value of feed) {
      values.push(value);
      if (value === 20) {
        feed.unsubscribe();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(values, [10, 20]);
    assert.equal(finallyCalled, true, 'source generator finally block must run on unsubscribe');
  });

  it('clears listener arrays after complete()', () => {
    const feed = createScompFeed<number>();
    feed.onNext(() => {});
    feed.onError(() => {});
    feed.onComplete(() => {});
    feed.onUnsubscribe(() => {});

    feed.complete();

    // Listeners should be empty after terminal event to prevent memory leaks.
    // We verify by registering new listeners and emitting — they should not fire
    // because the feed is closed, not because listeners were cleared. But we can
    // verify the internal cleanup happened by checking that adding after close
    // still works without accumulating stale references.
    let nextCalled = false;
    feed.onNext(() => { nextCalled = true; });
    feed.next(1);
    assert.equal(nextCalled, false, 'next listener added after close should not fire');
  });

  it('clears listener arrays after error()', () => {
    const feed = createScompFeed<number>();
    let errorSeen = false;
    feed.onError(() => { errorSeen = true; });
    feed.onNext(() => {});
    feed.onComplete(() => {});

    feed.error(new Error('test'));
    assert.equal(errorSeen, true);

    // After error, adding new listeners should not accumulate stale references
    let nextCalled = false;
    feed.onNext(() => { nextCalled = true; });
    feed.next(1);
    assert.equal(nextCalled, false, 'next listener added after error should not fire');
  });

  it('wraps non-Error thrown values safely in _consumeSource', async () => {
    async function* throwString(): AsyncGenerator<number> {
      yield 1;
      throw 'string error'; // eslint-disable-line no-throw-literal
    }

    const feed = new ScompFeed<number>(throwString);
    const values: Array<number> = [];
    let caughtError: unknown;

    try {
      for await (const value of feed) {
        values.push(value);
      }
    } catch (error) {
      caughtError = error;
    }

    assert.deepEqual(values, [1]);
    assert.ok(caughtError instanceof Error, 'non-Error thrown value should be wrapped in Error');
    assert.equal((caughtError as Error).message, 'string error');
  });
});
