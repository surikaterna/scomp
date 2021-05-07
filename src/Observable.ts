/**
 * new Observable(function(function onNext, function onError, function onComplete) observable) -> Observable
 */

import ControlledObservable from './ControlledObservable';

type onNextFunc = (next: any) => void;
type onErrorFunc = any;
type onCompleteFunc = any;
type DefaulteErrorType = Error;
export type ObservableFunc = (next: onNextFunc, error: onErrorFunc, complete: onCompleteFunc) => void;

export default class Observable<ResponseType = any, ErrorType = DefaulteErrorType> {
  private _onNextListener?: (res: ResponseType) => void;
  private _onErrorListener?: (error: any) => void;
  private _onCompleteListener?: (res: any) => void;
  private _onUnsubscribe?: () => void;
  public controller: any | null = null;

  constructor(fn: ObservableFunc) {
    fn(
      this.next.bind(this),
      this.error.bind(this),
      this.complete.bind(this)
    );
  }

  unsubscribe() {
    if (this._onUnsubscribe) {
      this._onUnsubscribe();
    }
  }

  isUnsubscribed() {
    return true;
  }

  next(nextResponse: any) {
    if (this._onNextListener) {
      this._onNextListener(nextResponse);
    }
  }

  error(errorResponse: any) {
    if (this._onErrorListener) {
      this._onErrorListener(errorResponse);
    }
  }

  complete(completeResponse: any) {
    if (this._onCompleteListener) {
      this._onCompleteListener(completeResponse);
    }
  }

  onNext(fn: (res: ResponseType) => void) {
    this._onNextListener = fn;
    return this;
  }

  onError(fn: (err: DefaulteErrorType) => void) {
    this._onErrorListener = fn;
    return this;
  }

  onComplete(fn: (res: any) => void) {
    this._onCompleteListener = fn;
    return this;
  }

  onUnsubscribe(fn: () => void) {
    this._onUnsubscribe = fn;
    return this;
  }
}
