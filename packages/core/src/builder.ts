import type { AnyContractMethod, ContractNetworkIntent, ContractMethodInput } from '@scomp/types';

type RouteKind = 'request' | 'signal' | 'feed';

export interface RequestImplementationConfig<Input, Output> {
  kind?: 'request';
  parser?: (payload: unknown) => Input;
  handler: (input: Input) => Promise<Output>;
}

export interface SignalImplementationConfig<Input> {
  kind: 'signal';
  parser?: (payload: unknown) => Input;
  handler: (input: Input) => void | Promise<void>;
}

export interface FeedImplementationConfig<Input, Output> {
  kind?: 'feed';
  parser?: (payload: unknown) => Input;
  strategy: 'fanout' | 'exclusive';
  hashKey?: (input: Input) => string;
  backpressure?: {
    highWaterMark?: number;
  };
  handler: (input: Input) => AsyncIterable<Output>;
}

type ContractMethodKeys<Contract extends object> = {
  [MethodName in keyof Contract]: Contract[MethodName] extends AnyContractMethod ? MethodName : never;
}[keyof Contract];

type RequestRawHandler<Method> = Method extends (input: infer Input) => Promise<infer Output>
  ? (input: Input) => Promise<Output>
  : never;

type SignalRawHandler<Method> = Method extends (input: infer Input) => void | Promise<void>
  ? (input: Input) => void | Promise<void>
  : never;

type FeedRawHandler<Method> = Method extends (input: infer Input) => AsyncIterable<infer Output>
  ? (input: Input) => AsyncIterable<Output>
  : never;

type MethodKind<Method extends AnyContractMethod> =
  ReturnType<Method> extends AsyncIterable<unknown>
    ? 'feed'
    : ReturnType<Method> extends void | Promise<void>
      ? 'signal'
      : ReturnType<Method> extends Promise<unknown>
        ? 'request'
        : never;

type RequestMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'request'
    ? RequestRawHandler<Method> | RequestImplementationConfig<ContractMethodInput<Method>, Awaited<ReturnType<Method>>>
    : never;

type SignalMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'signal'
    ? SignalRawHandler<Method> | SignalImplementationConfig<ContractMethodInput<Method>>
    : never;

type FeedMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'feed'
    ? FeedRawHandler<Method> | FeedImplementationConfig<ContractMethodInput<Method>, ReturnType<Method> extends AsyncIterable<infer Output> ? Output : never>
    : never;

type GroupedRequestImplementationConfig<Input, Output> = Omit<RequestImplementationConfig<Input, Output>, 'kind'>;
type GroupedSignalImplementationConfig<Input> = Omit<SignalImplementationConfig<Input>, 'kind'>;
type GroupedFeedImplementationConfig<Input, Output> = Omit<FeedImplementationConfig<Input, Output>, 'kind'>;

type GroupedRequestMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'request'
    ? RequestRawHandler<Method> | GroupedRequestImplementationConfig<ContractMethodInput<Method>, Awaited<ReturnType<Method>>>
    : never;

type GroupedSignalMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'signal'
    ? SignalRawHandler<Method> | GroupedSignalImplementationConfig<ContractMethodInput<Method>>
    : never;

type GroupedFeedMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends 'feed'
    ? FeedRawHandler<Method> | GroupedFeedImplementationConfig<ContractMethodInput<Method>, ReturnType<Method> extends AsyncIterable<infer Output> ? Output : never>
    : never;

type ContractMethodKeysByKind<Contract extends object, Kind extends RouteKind> = {
  [MethodName in ContractMethodKeys<Contract>]: MethodKind<Extract<Contract[MethodName], AnyContractMethod>> extends Kind
    ? MethodName
    : never;
}[ContractMethodKeys<Contract>];

type GroupedMethodImplementations<Contract extends object, Kind extends RouteKind> = {
  [MethodName in ContractMethodKeysByKind<Contract, Kind>]:
  Kind extends 'request'
    ? GroupedRequestMethodImplementation<Extract<Contract[MethodName], AnyContractMethod>>
    : Kind extends 'signal'
      ? GroupedSignalMethodImplementation<Extract<Contract[MethodName], AnyContractMethod>>
      : GroupedFeedMethodImplementation<Extract<Contract[MethodName], AnyContractMethod>>;
};

type MethodImplementation<Method extends AnyContractMethod> =
  RequestMethodImplementation<Method>
  | SignalMethodImplementation<Method>
  | FeedMethodImplementation<Method>;

export type ServiceMethodImplementations<Contract extends object> = {
  [MethodName in ContractMethodKeys<Contract>]: MethodImplementation<Extract<Contract[MethodName], AnyContractMethod>>;
};

export interface GroupedServiceMethodImplementations<Contract extends object> {
  requests: GroupedMethodImplementations<Contract, 'request'>;
  signals: GroupedMethodImplementations<Contract, 'signal'>;
  feeds: GroupedMethodImplementations<Contract, 'feed'>;
}

export interface CompiledRoute {
  route: string;
  kind: RouteKind;
  parser?: (payload: unknown) => unknown;
  strategy?: 'fanout' | 'exclusive';
  hashKey?: (payload: unknown) => string;
  backpressure?: {
    highWaterMark?: number;
  };
  handler: (payload: unknown) => unknown;
}

export type CompiledRouter = Record<string, CompiledRoute>;

export interface ServiceDefinition<Contract extends object> {
  name: string;
  networkIntent: ContractNetworkIntent<Contract>;
  router: CompiledRouter;
}

function normalizeMethodConfig(
  methodConfig: unknown,
  inferredKind: RouteKind,
  deterministicKind: boolean
): Omit<CompiledRoute, 'route'> {
  if (typeof methodConfig === 'function') {
    if (inferredKind === 'feed') {
      return {
        kind: inferredKind,
        strategy: 'exclusive',
        handler: methodConfig as (payload: unknown) => unknown
      };
    }

    return {
      kind: inferredKind,
      handler: methodConfig as (payload: unknown) => unknown
    };
  }

  const configObject = methodConfig as Record<string, unknown>;
  const kind = deterministicKind
    ? inferredKind
    : (configObject.kind as RouteKind | undefined) ?? inferredKind;
  return {
    kind,
    parser: configObject.parser as ((payload: unknown) => unknown) | undefined,
    strategy: configObject.strategy as 'fanout' | 'exclusive' | undefined,
    hashKey: configObject.hashKey as ((payload: unknown) => string) | undefined,
    backpressure: configObject.backpressure as { highWaterMark?: number } | undefined,
    handler: configObject.handler as (payload: unknown) => unknown
  };
}

function inferRouteKind(methodConfig: unknown): RouteKind {
  if (typeof methodConfig === 'function') {
    return 'request';
  }

  const configObject = methodConfig as Record<string, unknown>;
  if (configObject.kind === 'signal' || configObject.kind === 'request' || configObject.kind === 'feed') {
    return configObject.kind;
  }

  if (typeof configObject.strategy === 'string') {
    return 'feed';
  }

  return 'request';
}

function compileFlatRouter<Contract extends object>(
  name: string,
  methods: ServiceMethodImplementations<Contract>
): CompiledRouter {
  const router: CompiledRouter = {};

  for (const methodName of Object.keys(methods) as Array<ContractMethodKeys<Contract> & string>) {
    const implementation = methods[methodName];
    const route = `${name}.${methodName}`;

    const inferredKind = inferRouteKind(implementation);
    const normalized = normalizeMethodConfig(implementation, inferredKind, false);

    router[route] = {
      route,
      kind: normalized.kind,
      parser: normalized.parser,
      strategy: normalized.strategy,
      hashKey: normalized.hashKey,
      backpressure: normalized.backpressure,
      handler: normalized.handler
    };
  }

  return router;
}

function compileGroupedMethods(
  name: string,
  kind: RouteKind,
  methods: Record<string, unknown>,
  router: CompiledRouter
) {
  for (const methodName of Object.keys(methods)) {
    const implementation = methods[methodName];
    const route = `${name}.${methodName}`;
    const normalized = normalizeMethodConfig(implementation, kind, true);

    router[route] = {
      route,
      kind: normalized.kind,
      parser: normalized.parser,
      strategy: normalized.strategy,
      hashKey: normalized.hashKey,
      backpressure: normalized.backpressure,
      handler: normalized.handler
    };
  }
}

function compileGroupedRouter<Contract extends object>(
  name: string,
  groupedMethods: GroupedServiceMethodImplementations<Contract>
): CompiledRouter {
  const router: CompiledRouter = {};

  compileGroupedMethods(name, 'request', groupedMethods.requests as Record<string, unknown>, router);
  compileGroupedMethods(name, 'signal', groupedMethods.signals as Record<string, unknown>, router);
  compileGroupedMethods(name, 'feed', groupedMethods.feeds as Record<string, unknown>, router);

  return router;
}

function isGroupedMethods<Contract extends object>(
  methods: ServiceMethodImplementations<Contract> | GroupedServiceMethodImplementations<Contract>
): methods is GroupedServiceMethodImplementations<Contract> {
  if (typeof methods !== 'object' || methods === null) {
    return false;
  }

  const methodMap = methods as Record<string, unknown>;
  return 'requests' in methodMap && 'signals' in methodMap && 'feeds' in methodMap;
}

export function createScompService<Contract extends object>(name: string) {
  return {
    implement(
      methods: ServiceMethodImplementations<Contract> | GroupedServiceMethodImplementations<Contract>
    ): ServiceDefinition<Contract> {
      const router = isGroupedMethods(methods)
        ? compileGroupedRouter(name, methods)
        : compileFlatRouter(name, methods);

      return {
        name,
        networkIntent: {} as ContractNetworkIntent<Contract>,
        router
      };
    }
  };
}
