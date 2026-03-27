import ControlledObservable from './ControlledObservable';

type onNextFunc = (next: any) => void;
type onErrorFunc = any;
type onCompleteFunc = any;
type DefaulteErrorType = Error;

/**
 * Callback used to connect producers with an {@link Observable} instance.
 */
export type ObservableFunc = (next: onNextFunc, error: onErrorFunc, complete: onCompleteFunc) => void;

/**
 * Legacy observable implementation used by the original scomp runtime.
 *
 * @typeParam ResponseType - Type emitted by next notifications.
 * @typeParam ErrorType - Type emitted by error notifications.
 */
export default class Observable<ResponseType = any, ErrorType = DefaulteErrorType> {
  private _onNextListener?: (res: ResponseType) => void;
  private _onErrorListener?: (error: any) => void;
  private _onCompleteListener?: (res: any) => void;
  private _onUnsubscribe?: () => void;
  public controller: any | null = null;

  /**
   * Creates a new observable and subscribes to producer callbacks immediately.
   */
  constructor(fn: ObservableFunc) {
    fn(
      this.next.bind(this),
      this.error.bind(this),
      this.complete.bind(this)
    );
  }

  /** Unsubscribes from the underlying source. */
  unsubscribe() {
    if (this._onUnsubscribe) {
      this._onUnsubscribe();
    }
  }

  /** Returns whether the observable has been unsubscribed. */
  isUnsubscribed() {
    return true;
  }

  /** Emits a next value to listeners. */
  next(nextResponse: any) {
    if (this._onNextListener) {
      this._onNextListener(nextResponse);
    }
  }

  /** Emits an error value to listeners. */
  error(errorResponse: any) {
    if (this._onErrorListener) {
      this._onErrorListener(errorResponse);
    }
  }

  /** Emits a completion value to listeners. */
  complete(completeResponse: any) {
    if (this._onCompleteListener) {
      this._onCompleteListener(completeResponse);
    }
  }

  /** Registers a next listener. */
  onNext(fn: (res: ResponseType) => void) {
    this._onNextListener = fn;
    return this;
  }

  /** Registers an error listener. */
  onError(fn: (err: DefaulteErrorType) => void) {
    this._onErrorListener = fn;
    return this;
  }

  /** Registers a completion listener. */
  onComplete(fn: (res: any) => void) {
    this._onCompleteListener = fn;
    return this;
  }

  /** Registers an unsubscribe listener. */
  onUnsubscribe(fn: () => void) {
    this._onUnsubscribe = fn;
    return this;
  }
}
