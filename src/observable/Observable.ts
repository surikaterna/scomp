import { DefaultSubscriber, Subscriber } from './Subscriber';

import { Observer, Subscribable, Unsubscribable } from './types';

interface Subscription {}

/**
 *
 */
export default class Observable<T> implements Subscribable<T> {
  private _subscribe: (this: Observable<T>, subscriber: Subscriber<T>) => void;

  constructor(subscribe?: (this: Observable<T>, subscriber: Subscriber<T>) => void) {
    if (subscribe) {
      this._subscribe = subscribe;
    }
  }
  subscribe(observer: Partial<Observer<T>>): Unsubscribable {
    const subscriber = new DefaultSubscriber(observer);
    this._subscribe(subscriber);
    return subscriber;
  }

  /*  unsubscribe() {
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
  */
}

