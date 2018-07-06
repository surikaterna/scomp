/**
 * new Observable(function(function onNext, function onError, function onComplete) observable) -> Observable
 */
export default class Observable {
  constructor(fn) {
    fn(
      this._onNext.bind(this),
      this._onError.bind(this),
      this._onComplete.bind(this)
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

  _onNext(next) {
    if (this._onNextListener) {
      this._onNextListener(next);
    }
  }

  _onError(error) {
    if (this._onErrorListener) {
      this._onErrorListener(error);
    }
  }

  _onComplete(complete) {
    if (this._onCompleteListener) {
      this._onCompleteListener(complete);
    }
  }

  onNext(fn) {
    this._onNextListener = fn;
    return this;
  }

  onError(fn) {
    this._onErrorListener = fn;
    return this;
  }

  onComplete(fn) {
    this._onCompleteListener = fn;
    return this;
  }

  onUnsubscribe(fn) {
    this._onUnsubscribe = fn;
    return this;
  }
}
