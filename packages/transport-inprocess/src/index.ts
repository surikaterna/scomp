import {
  fromAsyncIterable,
  type ScompFeed,
  type ScompServiceDefinition,
  type ScompTransport
} from '@scomp/core';

type AnyServiceDefinition = ScompServiceDefinition<
  Record<string, (...args: Array<unknown>) => Promise<unknown>>,
  Record<string, (...args: Array<unknown>) => AsyncIterable<unknown> | Iterable<unknown>>,
  Record<string, (...args: Array<unknown>) => void | Promise<void>>
>;

/**
 * Configuration for {@link createInprocessTransport}.
 */
export interface InprocessTransportOptions {
  /**
   * Optional error sink for command failures.
   * If omitted, asynchronous command failures are re-thrown in a microtask.
   */
  onFireAndForgetError?: (error: unknown, methodName: string, args: ReadonlyArray<unknown>) => void;
}

function isScompFeed(value: unknown): value is ScompFeed<unknown, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeFeed = value as {
    onNext?: unknown;
    onError?: unknown;
    onComplete?: unknown;
    next?: unknown;
    error?: unknown;
    complete?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };

  return typeof maybeFeed.onNext === 'function'
    && typeof maybeFeed.onError === 'function'
    && typeof maybeFeed.onComplete === 'function'
    && typeof maybeFeed.next === 'function'
    && typeof maybeFeed.error === 'function'
    && typeof maybeFeed.complete === 'function'
    && typeof maybeFeed[Symbol.asyncIterator] === 'function';
}

function isIterableLike(value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeIterable = value as {
    [Symbol.iterator]?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };

  return typeof maybeIterable[Symbol.iterator] === 'function'
    || typeof maybeIterable[Symbol.asyncIterator] === 'function';
}

/**
 * Creates an in-process transport that directly invokes service handlers.
 */
export function createInprocessTransport(
  service: AnyServiceDefinition,
  options: InprocessTransportOptions = {}
): ScompTransport {
  return {
    async request<ResponseType>(methodName: string, args: ReadonlyArray<unknown>) {
      const result = service.invoke(methodName, args);

      if (isScompFeed(result) || isIterableLike(result)) {
        throw new Error(`Method ${methodName} is configured as a feed and cannot be used as request/response.`);
      }

      return Promise.resolve(result as ResponseType);
    },

    observe<ResponseType = unknown, ErrorType = Error>(
      methodName: string,
      args: ReadonlyArray<unknown>
    ) {
      const result = service.invoke(methodName, args);

      if (isScompFeed(result)) {
        return result as ScompFeed<ResponseType, ErrorType>;
      }

      if (isIterableLike(result)) {
        return fromAsyncIterable(result) as ScompFeed<ResponseType, ErrorType>;
      }

      throw new Error(`Method ${methodName} did not return a feed-compatible value.`);
    },

    fireAndForget(methodName: string, args: ReadonlyArray<unknown>) {
      try {
        const result = service.invoke(methodName, args);

        void Promise.resolve(result).catch((error) => {
          if (options.onFireAndForgetError) {
            options.onFireAndForgetError(error, methodName, args);
            return;
          }

          queueMicrotask(() => {
            throw error;
          });
        });
      } catch (error) {
        if (options.onFireAndForgetError) {
          options.onFireAndForgetError(error, methodName, args);
          return;
        }

        throw error;
      }
    }
  };
}
