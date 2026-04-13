import assert from "node:assert/strict";
import {
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  type LegacyObservableLike,
} from "../src";

describe("ScompFeed", () => {
  it("supports legacy handler chaining and completion", () => {
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

  it("supports generator consumption through async iteration", async () => {
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

  it("propagates errors to async iterators", async () => {
    const feed = createScompFeed<number>();
    const iterator = feed[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    const error = new Error("boom");
    feed.error(error);

    await assert.rejects(pendingNext, /boom/);
  });

  it("propagates async iterable failures to feed consumers", async () => {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw new Error("iterable boom");
      },
    };

    const feed = fromAsyncIterable(source);
    const iterator = feed[Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), { value: 1, done: false });
    await assert.rejects(iterator.next(), /iterable boom/);
  });

  it("can adapt legacy observable-like sources and forward unsubscribe", async () => {
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
});
