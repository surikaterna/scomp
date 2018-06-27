export default class Observable {
  constructor(fn) {
  }

  unsubscribe() {
  }

  isUnsubscribed() {
  }

  onNext(fn) {
    fn(1);
    return this;
  }

  onError(fn) {
    return this;
  }

  onComplete(fn){
    return this;
  }
}