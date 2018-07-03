export default class Observable {
  constructor(fn) {
    fn(
      this._onNext.bind(this),
      this._onError.bind(this),
      this._onComplete.bind(this)
    );
  }

  unsubscribe() {

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
      this._onNextListener(error);
    }
  }

  _onComplete(complete) {
    if (this._onCompleteListener) {
      this._onNextListener(complete);
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
}