import { ScompFeed, type ITransport } from '@scomp/core';
import type { ContractRouteIntents } from '@scomp/types';

type ContractMethod = (...args: Array<never>) => unknown;

type AsyncMethodOutput<Method> = Method extends ContractMethod & ((...args: Array<never>) => Promise<infer Output>)
  ? Output
  : never;

type FeedMethodOutput<Method> = Method extends ContractMethod & ((...args: Array<never>) => AsyncIterable<infer Output>)
  ? Output
  : never;

type UnknownFunction = (...args: Array<unknown>) => unknown;

export type ScompClientProxy<Contract extends object> = {
  [Key in keyof Contract]: Contract[Key] extends (...args: Array<never>) => AsyncIterable<unknown>
    ? (...args: Parameters<Contract[Key]>) => ScompFeed<FeedMethodOutput<Contract[Key]>>
    : Contract[Key] extends (...args: Array<never>) => void | Promise<void>
      ? (...args: Parameters<Contract[Key]>) => Promise<void>
      : Contract[Key] extends (...args: Array<never>) => Promise<unknown>
        ? (...args: Parameters<Contract[Key]>) => Promise<AsyncMethodOutput<Contract[Key]>>
        : Contract[Key] extends object
          ? ScompClientProxy<Contract[Key]>
          : never;
};

export interface ClientRouteHints {
  [route: string]: 'request' | 'signal' | 'feed';
}

export interface CreateScompClientConfig {
  transport: ITransport;
  routeHints?: ClientRouteHints;
}

function getRouteType(route: string, routeHints?: ClientRouteHints): 'request' | 'signal' | 'feed' {
  return routeHints?.[route] ?? 'request';
}

function createProxyNode(
  transport: ITransport,
  routeHints: ClientRouteHints | undefined,
  segments: Array<string>
): UnknownFunction {
  const target = () => {
    return undefined;
  };

  return new Proxy(target, {
    get(_target, prop, _receiver) {
      if (typeof prop !== 'string') {
        return undefined;
      }

      return createProxyNode(transport, routeHints, [...segments, prop]);
    },
    apply(_target, _thisArg, argArray: Array<unknown>) {
      const route = segments.join('.');
      const payload = argArray[0];
      const routeType = getRouteType(route, routeHints);

      if (routeType === 'signal') {
        return transport.signal(route, payload);
      }

      if (routeType === 'feed') {
        return new ScompFeed(async function* feedGenerator() {
          for await (const chunk of transport.feed(route, payload)) {
            yield chunk;
          }
        });
      }

      return transport.request(route, payload);
    }
  });
}

export function createScompClient<Contract extends object>(
  config: CreateScompClientConfig
): ScompClientProxy<Contract> {
  return createProxyNode(config.transport, config.routeHints, []) as unknown as ScompClientProxy<Contract>;
}

export type ClientRouteIntentMap<Contract extends object> = ContractRouteIntents<Contract>;
