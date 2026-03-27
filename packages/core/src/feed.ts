export interface ScompFeed<ResponseType = unknown, ErrorType = Error> extends AsyncIterable<ResponseType> {
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

export interface LegacyObservableLike<ResponseType = unknown, ErrorType = Error> {
  onNext?: (fn: (res: ResponseType) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  onError?: (fn: (err: ErrorType) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  onComplete?: (fn: (res: unknown) => void) => LegacyObservableLike<ResponseType, ErrorType>;
  unsubscribe?: () => void;
}

export class ScompFeedSubject<ResponseType = unknown, ErrorType = Error>
implements ScompFeed<ResponseType, ErrorType> {
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
        return { value: undefined, done: true };
      },
      throw: async (error) => {
        this.error(error as ErrorType);
        throw error;
      }
    };
  }

  unsubscribe() {
    if (this._isUnsubscribed) {
      return this;
    }

    this._isUnsubscribed = true;
    this._onUnsubscribe?.();
    this.complete();
    return this;
  }

  isUnsubscribed() {
    return this._isUnsubscribed;
  }

  next(nextResponse: ResponseType) {
    if (this._isClosed) {
      return this;
    }

    this._onNextListener?.(nextResponse);

    const pendingPull = this._pendingPulls.shift();
    if (pendingPull) {
      pendingPull.resolve({ value: nextResponse, done: false });
      return this;
    }

    this._eventQueue.push({ type: 'next', value: nextResponse });
    return this;
  }

  error(errorResponse: ErrorType) {
    if (this._isClosed) {
      return this;
    }

    this._onErrorListener?.(errorResponse);
    this._isClosed = true;

    const pendingPulls = this._pendingPulls.splice(0);
    if (pendingPulls.length > 0) {
      pendingPulls.forEach((pendingPull) => pendingPull.reject(errorResponse));
      return this;
    }

    this._eventQueue.push({ type: 'error', value: errorResponse });
    return this;
  }

  complete(completeResponse?: unknown) {
    if (this._isClosed) {
      return this;
    }

    this._onCompleteListener?.(completeResponse);
    this._isClosed = true;

    const pendingPulls = this._pendingPulls.splice(0);
    if (pendingPulls.length > 0) {
      pendingPulls.forEach((pendingPull) => pendingPull.resolve({ value: undefined, done: true }));
      return this;
    }

    this._eventQueue.push({ type: 'complete' });
    return this;
  }

  onNext(fn: (res: ResponseType) => void) {
    this._onNextListener = fn;
    return this;
  }

  onError(fn: (err: ErrorType) => void) {
    this._onErrorListener = fn;
    return this;
  }

  onComplete(fn: (res: unknown) => void) {
    this._onCompleteListener = fn;
    return this;
  }

  onUnsubscribe(fn: () => void) {
    this._onUnsubscribe = fn;
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
}

export function createScompFeed<ResponseType = unknown, ErrorType = Error>() {
  return new ScompFeedSubject<ResponseType, ErrorType>();
}

export function fromAsyncIterable<ResponseType>(
  iterable: AsyncIterable<ResponseType> | Iterable<ResponseType>
) {
  const feed = createScompFeed<ResponseType, unknown>();

  void (async () => {
    try {
      for await (const nextResponse of iterable) {
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

export function fromGenerator<ResponseType>(
  generator: (() => AsyncGenerator<ResponseType>) | (() => Generator<ResponseType>)
) {
  return fromAsyncIterable(generator());
}

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