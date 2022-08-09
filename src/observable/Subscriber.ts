import { wrap } from 'module';
import Subscription from './Subscription';
import { Observer } from './types';

export class Subscriber<T> extends Subscription implements Observer<T> {
  protected destination: Subscriber<any> | Observer<any>;

  next(value?: T): void {
    this.destination.next(value);
  }
  error(err?: any): void {
    this.destination.error(err);
  }
  complete(): void {
    this.destination.complete();
  }
  unsubscribe(): void {
    if (!this.closed) {
      super.unsubscribe();
    }
  }

  protected _next(value?: T): void {
    this.destination.next(value);
  }
  protected _error(err?: any): void {
    try {
      this.destination.error(err);
    } finally {
      this.unsubscribe();
    }
  }

  protected _complete(): void {
    try {
      this.destination.complete();
    } finally {
      this.unsubscribe();
    }
  }
}

export class DefaultSubscriber<T> extends Subscriber<T> {
  constructor(observerOrNext: Partial<Observer<T>>) {
    super();
    this.destination = new WrappedObserver(observerOrNext);
  }
}

class WrappedObserver<T> implements Observer<T> {
  constructor(private wrapped: Partial<Observer<T>>) {}

  next(value: T) {
    if (this.wrapped.next) {
      try {
        this.wrapped.next(value);
      } catch (error) {
        this.error(error);
      }
    }
  }
  error(err: any) {
    if (this.wrapped.error) {
      try {
        this.wrapped.error(err);
      } catch (error) {
        this.unhandledError(error);
      }
    } else {
      this.unhandledError(err);
    }
  }
  private unhandledError(err: any) {}
  complete() {
    if (this.wrapped.complete) {
      try {
        this.wrapped.complete();
      } catch (error) {
        this.error(error);
      }
    }
  }
}
