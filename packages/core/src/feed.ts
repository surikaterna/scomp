export interface ScompFeedLike<ResponseType = unknown, ErrorType = Error> extends AsyncIterable<ResponseType> {
  onNext(fn: (res: ResponseType) => void): this;
  onError(fn: (err: ErrorType) => void): this;
  onComplete(fn: (res: unknown) => void): this;
  onUnsubscribe(fn: () => void): this;
  next(nextResponse: ResponseType): this;
  error(errorResponse: ErrorType): this;
  complete(completeResponse?: unknown): this;
  unsubscribe(): this;
  isUnsubscribed(): boolean;
}

type FeedEvent<ResponseType, ErrorType> =
  | { type: 'next'; value: ResponseType }
  | { type: 'error'; value: ErrorType }
  | { type: 'complete' };

type PendingPull<ResponseType> = {
  resolve: (value: IteratorResult<ResponseType>) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Safely coerce an unknown thrown value to the expected error type.
 * Returns the value as-is when it's already an Error (the common case).
 * Wraps non-Error values in a standard Error so callers always get a
 * well-formed error object.
 */
function toErrorType<ErrorType>(value: unknown): ErrorType {
  if (value instanceof Error) {
    return value as ErrorType;
  }
  return new Error(String(value)) as ErrorType;
}

/**
 * Compatibility shape for adapting legacy observable implementations.
 */
export interface LegacyObservableLike<ResponseType = unknown, ErrorType = Error> {
  onNext?: (fn: (res: ResponseType) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  onError?: (fn: (err: ErrorType) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  onComplete?: (fn: (res: unknown) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  unsubscribe?: () => void;
}

/**
 * Concrete feed implementation that supports both callback and async-iterator consumption.
 *
 * @typeParam ResponseType - Type emitted through next values.
 * @typeParam ErrorType - Type emitted through terminal errors.
 */
export class ScompFeed<ResponseType = unknown, ErrorType = Error>
implements ScompFeedLike<ResponseType, ErrorType> {
  private readonly _onNextListeners: Array<(res: ResponseType) => void> = [];
  private readonly _onErrorListeners: Array<(error: ErrorType) => void> = [];
  private readonly _onCompleteListeners: Array<(res: unknown) => void> = [];
  private readonly _onUnsubscribeListeners: Array<() => void> = [];
  private _eventQueue: Array<FeedEvent<ResponseType, ErrorType>> = [];
  private _pendingPulls: Array<PendingPull<ResponseType>> = [];
  private _isClosed = false;
  private _isUnsubscribed = false;

  constructor(source?: AsyncIterable<ResponseType> | (() => AsyncIterable<ResponseType>)) {
    if (!source) {
      return;
    }

    const iterable = typeof source === 'function' ? source() : source;
    void this._consumeSource(iterable);
  }

  [Symbol.asyncIterator](): AsyncIterator<ResponseType> {
    return {
      next: () => this._nextIteratorValue(),
      return: async () => {
        this.unsubscribe();
        return { value: undefined, done: true };
      },
      throw: async (error) => {
        this.error(error as ErrorType);
        throw error;
      }
    };
  }

  /** @inheritdoc */
  unsubscribe() {
    if (this._isUnsubscribed) {
      return this;
    }

    this._isUnsubscribed = true;
    for (const listener of this._onUnsubscribeListeners) {
      listener();
    }
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

    for (const listener of this._onNextListeners) {
      listener(nextResponse);
    }

    const pendingPull = this._pendingPulls.shift();
    if (pendingPull) {
      pendingPull.resolve({ value: nextResponse, done: false });
      return this;
    }

    this._eventQueue.push({ type: 'next', value: nextResponse });
    return this;
  }

  /** @inheritdoc */
  error(errorResponse: ErrorType) {
    if (this._isClosed) {
      return this;
    }

    for (const listener of this._onErrorListeners) {
      listener(errorResponse);
    }
    this._isClosed = true;

    const pendingPulls = this._pendingPulls.splice(0);
    if (pendingPulls.length > 0) {
      pendingPulls.forEach((pendingPull) => pendingPull.reject(errorResponse));
    } else {
      this._eventQueue.push({ type: 'error', value: errorResponse });
    }

    this._clearListeners();
    return this;
  }

  /** @inheritdoc */
  complete(completeResponse?: unknown) {
    if (this._isClosed) {
      return this;
    }

    for (const listener of this._onCompleteListeners) {
      listener(completeResponse);
    }
    this._isClosed = true;

    const pendingPulls = this._pendingPulls.splice(0);
    if (pendingPulls.length > 0) {
      pendingPulls.forEach((pendingPull) => pendingPull.resolve({ value: undefined, done: true }));
    } else {
      this._eventQueue.push({ type: 'complete' });
    }

    this._clearListeners();
    return this;
  }

  /** @inheritdoc */
  onNext(fn: (res: ResponseType) => void) {
    this._onNextListeners.push(fn);
    return this;
  }

  /** @inheritdoc */
  onError(fn: (err: ErrorType) => void) {
    this._onErrorListeners.push(fn);
    return this;
  }

  /** @inheritdoc */
  onComplete(fn: (res: unknown) => void) {
    this._onCompleteListeners.push(fn);
    return this;
  }

  /** @inheritdoc */
  onUnsubscribe(fn: () => void) {
    this._onUnsubscribeListeners.push(fn);
    return this;
  }

  private _nextIteratorValue(): Promise<IteratorResult<ResponseType>> {
    const queuedEvent = this._eventQueue.shift();
    if (queuedEvent) {
      return this._resolveQueuedEvent(queuedEvent);
    }

    if (this._isClosed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise((resolve, reject) => {
      this._pendingPulls.push({ resolve, reject });
    });
  }

  private _resolveQueuedEvent(event: FeedEvent<ResponseType, ErrorType>): Promise<IteratorResult<ResponseType>> {
    if (event.type === 'next') {
      return Promise.resolve({ value: event.value, done: false });
    }

    if (event.type === 'error') {
      return Promise.reject(event.value);
    }

    return Promise.resolve({ value: undefined, done: true });
  }

  private _clearListeners(): void {
    this._onNextListeners.length = 0;
    this._onErrorListeners.length = 0;
    this._onCompleteListeners.length = 0;
    this._onUnsubscribeListeners.length = 0;
  }

  private async _consumeSource(iterable: AsyncIterable<ResponseType>): Promise<void> {
    try {
      for await (const value of iterable) {
        if (this._isUnsubscribed) {
          break;
        }
        this.next(value);
      }
      this.complete();
    } catch (error) {
      this.error(toErrorType<ErrorType>(error));
    }
  }
}

/**
 * Creates a new mutable feed subject.
 */
export function createScompFeed<ResponseType = unknown, ErrorType = Error>() {
  return new ScompFeed<ResponseType, ErrorType>();
}

/**
 * Adapts an async or sync iterable into a {@link ScompFeed}.
 */
export function fromAsyncIterable<ResponseType>(
  iterable: AsyncIterable<ResponseType> | Iterable<ResponseType>
) {
  const feed = createScompFeed<ResponseType, unknown>();

  void (async () => {
    try {
      for await (const nextResponse of iterable) {
        if (feed.isUnsubscribed()) {
          break;
        }
        feed.next(nextResponse);
      }
      feed.complete();
    } catch (error) {
      feed.error(toErrorType(error));
    }
  })();

  return feed;
}

/**
 * Adapts a generator factory into a {@link ScompFeed}.
 */
export function fromGenerator<ResponseType>(
  generator: (() => AsyncGenerator<ResponseType>) | (() => Generator<ResponseType>)
) {
  return fromAsyncIterable(generator());
}

/**
 * Adapts a legacy observable-like source into a {@link ScompFeed}.
 */
export function fromLegacyObservable<ResponseType = unknown, ErrorType = Error>(
  source: LegacyObservableLike<ResponseType, ErrorType>
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