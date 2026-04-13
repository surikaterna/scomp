/**
 * Push-based stream abstraction used by scomp feed methods.
 *
 * @typeParam ResponseType - Type emitted by {@link ScompFeed.next} and async iteration.
 * @typeParam ErrorType - Type emitted by {@link ScompFeed.error}.
 */
export interface ScompFeed<
  ResponseType = unknown,
  ErrorType = Error,
> extends AsyncIterable<ResponseType> {
  /** Registers a listener for next values. */
  onNext(fn: (res: ResponseType) => void): this;
  /** Registers a listener for terminal errors. */
  onError(fn: (err: ErrorType) => void): this;
  /** Registers a listener for completion. */
  onComplete(fn: (res: unknown) => void): this;
  /** Registers a listener for unsubscribe notifications. */
  onUnsubscribe(fn: () => void): this;
  /** Emits a next value to listeners and async iterators. */
  next(nextResponse: ResponseType): this;
  /** Emits an error and closes the feed. */
  error(errorResponse: ErrorType): this;
  /** Completes the feed and closes all pending iterators. */
  complete(completeResponse?: unknown): this;
  /** Stops the feed and invokes unsubscribe listeners. */
  unsubscribe(): this;
  /** Returns whether the feed has already been unsubscribed. */
  isUnsubscribed(): boolean;
}

type FeedEvent<ResponseType, ErrorType> =
  | { type: "next"; value: ResponseType }
  | { type: "error"; value: ErrorType }
  | { type: "complete" };

type PendingPull<ResponseType> = {
  resolve: (value: IteratorResult<ResponseType>) => void;
  reject: (reason?: unknown) => void;
};

type AsyncIterableFactory<ResponseType> = () => AsyncIterable<ResponseType>;

function toIteratorResult<ResponseType>(
  value: ResponseType,
  done: false,
): IteratorYieldResult<ResponseType>;
function toIteratorResult<ResponseType>(
  value: undefined,
  done: true,
): IteratorReturnResult<undefined>;
function toIteratorResult<ResponseType>(
  value: ResponseType | undefined,
  done: boolean,
): IteratorResult<ResponseType> {
  return { value, done } as IteratorResult<ResponseType>;
}

function settlePendingPulls<ResponseType>(
  pendingPulls: Array<PendingPull<ResponseType>>,
  settle: (pendingPull: PendingPull<ResponseType>) => void,
) {
  for (const pendingPull of pendingPulls.splice(0)) {
    settle(pendingPull);
  }
}

function toAsyncIterable<ResponseType>(
  iterable: AsyncIterable<ResponseType> | Iterable<ResponseType>,
): AsyncIterable<ResponseType> {
  if (Symbol.asyncIterator in iterable) {
    return iterable as AsyncIterable<ResponseType>;
  }

  return (async function* () {
    for (const value of iterable as Iterable<ResponseType>) {
      yield value;
    }
  })();
}

/**
 * Compatibility shape for adapting legacy observable implementations.
 */
export interface LegacyObservableLike<
  ResponseType = unknown,
  ErrorType = Error,
> {
  onNext?: (
    fn: (res: ResponseType) => void,
  ) => LegacyObservableLike<ResponseType, ErrorType>;
  onError?: (
    fn: (err: ErrorType) => void,
  ) => LegacyObservableLike<ResponseType, ErrorType>;
  onComplete?: (
    fn: (res: unknown) => void,
  ) => LegacyObservableLike<ResponseType, ErrorType>;
  unsubscribe?: () => void;
}

/**
 * Concrete feed implementation that supports both callback and async-iterator consumption.
 *
 * @typeParam ResponseType - Type emitted through next values.
 * @typeParam ErrorType - Type emitted through terminal errors.
 */
export class ScompFeedSubject<
  ResponseType = unknown,
  ErrorType = Error,
> implements ScompFeed<ResponseType, ErrorType> {
  private _onNextListener?: (res: ResponseType) => void;
  private _onErrorListener?: (error: ErrorType) => void;
  private _onCompleteListener?: (res: unknown) => void;
  private _onUnsubscribe?: () => void;
  private _eventQueue: Array<FeedEvent<ResponseType, ErrorType>> = [];
  private _pendingPulls: Array<PendingPull<ResponseType>> = [];
  private _isClosed = false;
  private _isUnsubscribed = false;

  [Symbol.asyncIterator](): AsyncIterator<ResponseType> {
    return {
      next: () => this._nextIteratorValue(),
      return: async () => {
        this.unsubscribe();
        return toIteratorResult<ResponseType>(undefined, true);
      },
      throw: async (error) => {
        this.error(error as ErrorType);
        throw error;
      },
    };
  }

  /** @inheritdoc */
  unsubscribe() {
    if (this._isUnsubscribed) {
      return this;
    }

    this._isUnsubscribed = true;
    this._onUnsubscribe?.();
    this.complete();
    return this;
  }

  /** @inheritdoc */
  isUnsubscribed() {
    return this._isUnsubscribed;
  }

  /** @inheritdoc */
  next(nextResponse: ResponseType) {
    if (this._isClosed) {
      return this;
    }

    this._onNextListener?.(nextResponse);

    const pendingPull = this._pendingPulls.shift();
    if (pendingPull) {
      pendingPull.resolve(toIteratorResult(nextResponse, false));
      return this;
    }

    this._eventQueue.push({ type: "next", value: nextResponse });
    return this;
  }

  /** @inheritdoc */
  error(errorResponse: ErrorType) {
    if (this._close("error", errorResponse)) {
      this._onErrorListener?.(errorResponse);
    }
    return this;
  }

  /** @inheritdoc */
  complete(completeResponse?: unknown) {
    if (this._close("complete", completeResponse)) {
      this._onCompleteListener?.(completeResponse);
    }
    return this;
  }

  /** @inheritdoc */
  onNext(fn: (res: ResponseType) => void) {
    this._onNextListener = fn;
    return this;
  }

  /** @inheritdoc */
  onError(fn: (err: ErrorType) => void) {
    this._onErrorListener = fn;
    return this;
  }

  /** @inheritdoc */
  onComplete(fn: (res: unknown) => void) {
    this._onCompleteListener = fn;
    return this;
  }

  /** @inheritdoc */
  onUnsubscribe(fn: () => void) {
    this._onUnsubscribe = fn;
    return this;
  }

  private _close(type: "error", value: ErrorType): boolean;
  private _close(type: "complete", value?: unknown): boolean;
  private _close(type: "error" | "complete", value?: unknown): boolean {
    if (this._isClosed) {
      return false;
    }

    this._isClosed = true;

    if (type === "error") {
      if (this._pendingPulls.length > 0) {
        settlePendingPulls(this._pendingPulls, (pendingPull) =>
          pendingPull.reject(value),
        );
      } else {
        this._eventQueue.push({ type: "error", value: value as ErrorType });
      }

      return true;
    }

    if (this._pendingPulls.length > 0) {
      settlePendingPulls(this._pendingPulls, (pendingPull) => {
        pendingPull.resolve(toIteratorResult(undefined, true));
      });
    } else {
      this._eventQueue.push({ type: "complete" });
    }

    return true;
  }

  private _nextIteratorValue(): Promise<IteratorResult<ResponseType>> {
    const queuedEvent = this._eventQueue.shift();
    if (queuedEvent) {
      return this._resolveQueuedEvent(queuedEvent);
    }

    if (this._isClosed) {
      return Promise.resolve(toIteratorResult(undefined, true));
    }

    return new Promise((resolve, reject) => {
      this._pendingPulls.push({ resolve, reject });
    });
  }

  private _resolveQueuedEvent(
    event: FeedEvent<ResponseType, ErrorType>,
  ): Promise<IteratorResult<ResponseType>> {
    if (event.type === "next") {
      return Promise.resolve(toIteratorResult(event.value, false));
    }

    if (event.type === "error") {
      return Promise.reject(event.value);
    }

    return Promise.resolve(toIteratorResult(undefined, true));
  }
}

/**
 * Creates a new mutable feed subject.
 */
export function createScompFeed<ResponseType = unknown, ErrorType = Error>() {
  return new ScompFeedSubject<ResponseType, ErrorType>();
}

/**
 * Adapts an async or sync iterable into a {@link ScompFeed}.
 */
export function fromAsyncIterable<ResponseType>(
  iterable: AsyncIterable<ResponseType> | Iterable<ResponseType>,
) {
  const feed = createScompFeed<ResponseType, unknown>();
  const source = toAsyncIterable(iterable);

  void (async () => {
    try {
      for await (const nextResponse of source) {
        if (feed.isUnsubscribed()) {
          return;
        }
        feed.next(nextResponse);
      }
      feed.complete();
    } catch (error) {
      feed.error(error);
    }
  })();

  return feed;
}

/**
 * Adapts a generator factory into a {@link ScompFeed}.
 */
export function fromGenerator<ResponseType>(
  generator: AsyncIterableFactory<ResponseType>,
) {
  return fromAsyncIterable(generator());
}

/**
 * Adapts a legacy observable-like source into a {@link ScompFeed}.
 */
export function fromLegacyObservable<ResponseType = unknown, ErrorType = Error>(
  source: LegacyObservableLike<ResponseType, ErrorType>,
) {
  const feed = createScompFeed<ResponseType, ErrorType>();

  source.onNext?.((nextResponse) => {
    feed.next(nextResponse);
  });
  source.onError?.((errorResponse) => {
    feed.error(errorResponse);
  });
  source.onComplete?.((completeResponse) => {
    feed.complete(completeResponse);
  });

  feed.onUnsubscribe(() => {
    source.unsubscribe?.();
  });

  return feed;
}
