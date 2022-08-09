import isFunction from '../util/isFunction';
import { SubscriptionLike } from './types';

export default class Subscription implements SubscriptionLike {
  readonly closed = false;
  unsubscribe(): void {}
}

export function isSubscription(value: any): value is Subscription {
  return value instanceof Subscription || (value && 'closed' in value && isFunction(value.remove) && isFunction(value.add) && isFunction(value.unsubscribe));
}
