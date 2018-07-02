export default class Observable {
  constructor(fn) {
  }

  unsubscribe() {
  }

  isUnsubscribed() {
    return true;
  }

  _getNext() {
    return this._onNext;
  }

  onNext(fn) {
    this._onNext = fn;
    return this;
  }

  onError(fn) {
    this._onError = fn;
    return this;
  }

  onComplete(fn){
    this._onComplete = fn;
    return this;
  }
}