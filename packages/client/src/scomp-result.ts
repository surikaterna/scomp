/**
 * A dual-protocol return value that is both PromiseLike<T> and AsyncIterable<T>.
 *
 * - When awaited (`await result`): resolves via .then() — returns value for requests, void for signals
 * - When iterated (`for await (const x of result)`): uses [Symbol.asyncIterator]() — streams for feeds
 *
 * JavaScript's for-await-of checks [Symbol.asyncIterator] FIRST without unwrapping thenables,
 * so the same object correctly serves both usage patterns.
 */
export interface ScompResult<T> extends PromiseLike<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createScompResult<T>(promise: Promise<unknown>): ScompResult<T> {
  let setupPromise: Promise<void> | null = null;
  let resolved = false;
  let resolvedValue: unknown;
  let resolveError: unknown;
  let actualIterator: AsyncIterator<T> | null = null;
  let streamIterator: AsyncIterator<T> | null = null;

  // Start resolution eagerly
  setupPromise = promise.then(
    (value) => {
      resolved = true;
      resolvedValue = value;
      if (value != null && typeof value === "object" && Symbol.asyncIterator in (value as object)) {
        actualIterator = (value as AsyncIterable<T>)[Symbol.asyncIterator]();
      }
    },
    (err) => {
      resolved = true;
      resolveError = err;
    },
  );

  return {
    // biome-ignore lint/suspicious/noThenProperty: intentionally implementing PromiseLike
    then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return promise.then((value) => {
        if (onfulfilled) return onfulfilled(value as T);
        return value as unknown as TResult1;
      }, onrejected);
    },

    [Symbol.asyncIterator](): AsyncIterator<T> {
      if (streamIterator) return streamIterator;

      let singleValueConsumed = false;

      streamIterator = {
        async next(): Promise<IteratorResult<T>> {
          if (!resolved) await setupPromise;
          if (resolveError) throw resolveError;

          if (actualIterator) {
            return actualIterator.next();
          }

          // Not a stream — yield single value then done
          if (!singleValueConsumed && resolvedValue !== undefined) {
            singleValueConsumed = true;
            return { done: false, value: resolvedValue as T };
          }

          return { done: true, value: undefined };
        },

        async return(): Promise<IteratorResult<T>> {
          if (actualIterator?.return) {
            return actualIterator.return(undefined);
          }
          return { done: true, value: undefined };
        },

        async throw(err?: unknown): Promise<IteratorResult<T>> {
          if (actualIterator?.throw) {
            return actualIterator.throw(err);
          }
          throw err;
        },
      };

      return streamIterator;
    },
  };
}
