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

export type FragmentMethodImplementations<Contract extends object> = Partial<ServiceMethodImplementations<Contract>>;

type FlatServiceMethodImplementationsInput<Contract extends object> = Partial<ServiceMethodImplementations<Contract>>;

export interface GroupedServiceMethodImplementations<Contract extends object> {
  requests: GroupedMethodImplementations<Contract, 'request'>;
  signals: GroupedMethodImplementations<Contract, 'signal'>;
  feeds: GroupedMethodImplementations<Contract, 'feed'>;
}

interface GroupedServiceMethodImplementationsInput<Contract extends object> {
  requests?: Partial<GroupedMethodImplementations<Contract, 'request'>>;
  signals?: Partial<GroupedMethodImplementations<Contract, 'signal'>>;
  feeds?: Partial<GroupedMethodImplementations<Contract, 'feed'>>;
}

export interface GroupedFragmentMethodImplementations<Contract extends object> {
  requests?: Partial<GroupedMethodImplementations<Contract, 'request'>>;
  signals?: Partial<GroupedMethodImplementations<Contract, 'signal'>>;
  feeds?: Partial<GroupedMethodImplementations<Contract, 'feed'>>;
}

type ServiceMethodImplementationsInput<Contract extends object> =
  | FlatServiceMethodImplementationsInput<Contract>
  | GroupedServiceMethodImplementationsInput<Contract>;

type GroupedProvidedMethodKeys<Grouped> =
  Grouped extends {
    requests?: infer Requests;
    signals?: infer Signals;
    feeds?: infer Feeds;
  }
    ? keyof NonNullable<Requests> | keyof NonNullable<Signals> | keyof NonNullable<Feeds>
    : never;

type ProvidedMethodKeys<Methods> = Methods extends {
  requests?: unknown;
  signals?: unknown;
  feeds?: unknown;
}
  ? GroupedProvidedMethodKeys<Methods>
  : keyof Methods;

type MissingServiceMethodKeys<Contract extends object, Methods> = Exclude<
  ContractMethodKeys<Contract>,
  ProvidedMethodKeys<Methods>
>;

type UnknownServiceMethodKeys<Contract extends object, Methods> = Exclude<
  ProvidedMethodKeys<Methods>,
  ContractMethodKeys<Contract>
>;

type EnsureKnownServiceMethods<Contract extends object, Methods> =
  [UnknownServiceMethodKeys<Contract, Methods>] extends [never]
    ? {}
    : {
      __scomp_unknown_methods__: {
        [MethodName in UnknownServiceMethodKeys<Contract, Methods>]: 'Method is not in contract';
      };
    };

type EnsureCompleteServiceImplementation<Contract extends object, Methods> =
  [MissingServiceMethodKeys<Contract, Methods>] extends [never]
    ? {}
    : {
      __scomp_missing_methods__: {
        [MethodName in MissingServiceMethodKeys<Contract, Methods>]: 'Missing contract implementation';
      };
    };

type StrictServiceImplementationChecks<Contract extends object, Methods> =
  EnsureKnownServiceMethods<Contract, Methods>
  & EnsureCompleteServiceImplementation<Contract, Methods>;

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

export interface FragmentDefinition<Contract extends object, Methods extends string = never> {
  name: string;
  networkIntent: Partial<ContractNetworkIntent<Contract>>;
  router: CompiledRouter;
  readonly __scomp_fragment_methods__?: Methods;
}

type FragmentMethodNames<Fragment> =
  Fragment extends FragmentDefinition<object, infer Methods>
    ? Methods
    : never;

type CombinedFragmentMethodNames<Fragments extends readonly unknown[]> =
  Fragments extends readonly [infer Fragment, ...infer Rest]
    ? FragmentMethodNames<Fragment> | CombinedFragmentMethodNames<Rest>
    : never;

type DuplicateFragmentMethodNames<
  Fragments extends readonly unknown[],
  Seen extends string = never,
  Duplicates extends string = never
> = Fragments extends readonly [infer Fragment, ...infer Rest]
  ? DuplicateFragmentMethodNames<
    Rest,
    Seen | FragmentMethodNames<Fragment>,
    Duplicates | Extract<FragmentMethodNames<Fragment>, Seen>
  >
  : Duplicates;

type EnsureNoDuplicateFragmentMethods<Fragments extends readonly unknown[]> =
  [DuplicateFragmentMethodNames<Fragments>] extends [never]
    ? {}
    : {
      __scomp_duplicate_fragment_methods__: {
        [MethodName in DuplicateFragmentMethodNames<Fragments>]: 'Duplicate method declared across fragments';
      };
    };

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

function compileFlatRouter(
  name: string,
  methods: Record<string, unknown>
): CompiledRouter {
  const router: CompiledRouter = {};

  for (const methodName of Object.keys(methods)) {
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
  groupedMethods:
    | GroupedServiceMethodImplementations<Contract>
    | GroupedServiceMethodImplementationsInput<Contract>
    | GroupedFragmentMethodImplementations<Contract>
): CompiledRouter {
  const router: CompiledRouter = {};

  compileGroupedMethods(name, 'request', (groupedMethods.requests ?? {}) as Record<string, unknown>, router);
  compileGroupedMethods(name, 'signal', (groupedMethods.signals ?? {}) as Record<string, unknown>, router);
  compileGroupedMethods(name, 'feed', (groupedMethods.feeds ?? {}) as Record<string, unknown>, router);

  return router;
}

function isGroupedMethods(methods: unknown): methods is {
  requests?: Record<string, unknown>;
  signals?: Record<string, unknown>;
  feeds?: Record<string, unknown>;
} {
  if (typeof methods !== 'object' || methods === null) {
    return false;
  }

  const methodMap = methods as Record<string, unknown>;
  const methodKeys = Object.keys(methodMap);
  if (methodKeys.length === 0) {
    return false;
  }

  return methodKeys.every((key) => key === 'requests' || key === 'signals' || key === 'feeds');
}

export function createScompService<Contract extends object>(name: string) {
  return {
    implement<Methods extends ServiceMethodImplementationsInput<Contract>>(
      methods: Methods & StrictServiceImplementationChecks<Contract, Methods>
    ): ServiceDefinition<Contract> {
      const router = isGroupedMethods(methods)
        ? compileGroupedRouter(name, methods)
        : compileFlatRouter(name, methods as Record<string, unknown>);

      return {
        name,
        networkIntent: {} as ContractNetworkIntent<Contract>,
        router
      };
    }
  };
}

export function createScompFragment<Contract extends object>(name: string) {
  return {
    implement<Methods extends FragmentMethodImplementations<Contract> | GroupedFragmentMethodImplementations<Contract>>(
      methods: Methods
    ): FragmentDefinition<Contract, Extract<ProvidedMethodKeys<Methods>, string>> {
      const router = isGroupedMethods(methods)
        ? compileGroupedRouter(name, methods)
        : compileFlatRouter(name, methods as Record<string, unknown>);

      return {
        name,
        networkIntent: {} as Partial<ContractNetworkIntent<Contract>>,
        router
      };
    }
  };
}

export function composeScompFragments<
  Contract extends object,
  Fragments extends readonly [
    FragmentDefinition<Contract, string>,
    ...Array<FragmentDefinition<Contract, string>>
  ]
>(
  ...fragments: Fragments & EnsureNoDuplicateFragmentMethods<Fragments>
): FragmentDefinition<Contract, CombinedFragmentMethodNames<Fragments>> {
  const [firstFragment] = fragments;
  const name = firstFragment.name;
  const router: CompiledRouter = {};
  const networkIntent: Partial<ContractNetworkIntent<Contract>> = {};

  const methodToSource = new Map<string, { fragmentLabel: string; route: string }>();

  for (const [index, fragment] of fragments.entries()) {
    const fragmentLabel = `${fragment.name}#${index + 1}`;

    if (fragment.name !== name) {
      throw new Error(`Cannot compose fragments with different names: expected "${name}", got "${fragment.name}"`);
    }

    Object.assign(networkIntent, fragment.networkIntent);

    for (const [routeName, route] of Object.entries(fragment.router)) {
      const separatorIndex = routeName.indexOf('.');
      const methodName = separatorIndex === -1 ? routeName : routeName.slice(separatorIndex + 1);
      const existingSource = methodToSource.get(methodName);

      if (existingSource) {
        throw new Error(
          `Duplicate method "${methodName}" defined by fragments ${existingSource.fragmentLabel} (${existingSource.route}) and ${fragmentLabel} (${routeName})`
        );
      }

      methodToSource.set(methodName, { fragmentLabel, route: routeName });

      if (router[routeName]) {
        throw new Error(`Duplicate route "${routeName}" while composing fragments`);
      }

      router[routeName] = route;
    }
  }

  return {
    name,
    networkIntent,
    router
  };
}
