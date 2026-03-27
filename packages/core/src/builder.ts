import type { ContractNetworkIntent, ContractMethodInput } from '@scomp/types';

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

type ContractFunctionMap = Record<string, (input: any) => any>;

type RequestRawHandler<Method extends (input: any) => Promise<any>> = (
  input: ContractMethodInput<Method>
) => ReturnType<Method>;

type SignalRawHandler<Method extends (input: any) => void | Promise<void>> = (
  input: ContractMethodInput<Method>
) => ReturnType<Method>;

type FeedRawHandler<Method extends (input: any) => AsyncIterable<any>> = (
  input: ContractMethodInput<Method>
) => ReturnType<Method>;

type MethodImplementation<Method extends (input: any) => any> =
  ReturnType<Method> extends AsyncIterable<infer FeedOutput>
    ? FeedRawHandler<Method> | FeedImplementationConfig<ContractMethodInput<Method>, FeedOutput>
    : ReturnType<Method> extends void | Promise<void>
      ? SignalRawHandler<Method> | SignalImplementationConfig<ContractMethodInput<Method>>
      : ReturnType<Method> extends Promise<infer RequestOutput>
        ? RequestRawHandler<Method> | RequestImplementationConfig<ContractMethodInput<Method>, RequestOutput>
        : never;

export type ServiceMethodImplementations<Contract extends ContractFunctionMap> = {
  [MethodName in keyof Contract]: MethodImplementation<Contract[MethodName]>;
};

export interface CompiledRoute {
  route: string;
  kind: 'request' | 'signal' | 'feed';
  parser?: (payload: unknown) => unknown;
  strategy?: 'fanout' | 'exclusive';
  hashKey?: (payload: unknown) => string;
  backpressure?: {
    highWaterMark?: number;
  };
  handler: (payload: unknown) => unknown;
}

export type CompiledRouter = Record<string, CompiledRoute>;

export interface ServiceDefinition<Contract extends ContractFunctionMap> {
  name: string;
  networkIntent: ContractNetworkIntent<Contract>;
  router: CompiledRouter;
}

function normalizeMethodConfig(methodConfig: unknown, inferredKind: 'request' | 'signal' | 'feed'): Omit<CompiledRoute, 'route'> {
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
  const kind = (configObject.kind as 'request' | 'signal' | 'feed' | undefined) ?? inferredKind;
  return {
    kind,
    parser: configObject.parser as ((payload: unknown) => unknown) | undefined,
    strategy: configObject.strategy as 'fanout' | 'exclusive' | undefined,
    hashKey: configObject.hashKey as ((payload: unknown) => string) | undefined,
    backpressure: configObject.backpressure as { highWaterMark?: number } | undefined,
    handler: configObject.handler as (payload: unknown) => unknown
  };
}

function inferRouteKind(methodConfig: unknown): 'request' | 'signal' | 'feed' {
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

function compileRouter<Contract extends ContractFunctionMap>(
  name: string,
  methods: ServiceMethodImplementations<Contract>
): CompiledRouter {
  const router: CompiledRouter = {};

  for (const methodName of Object.keys(methods) as Array<keyof Contract & string>) {
    const implementation = methods[methodName];
    const route = `${name}.${methodName}`;

    const inferredKind = inferRouteKind(implementation);
    const normalized = normalizeMethodConfig(implementation, inferredKind);

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

export function createScompService<Contract extends ContractFunctionMap>(name: string) {
  return {
    implement(methods: ServiceMethodImplementations<Contract>): ServiceDefinition<Contract> {
      const router = compileRouter(name, methods);

      return {
        name,
        networkIntent: {} as ContractNetworkIntent<Contract>,
        router
      };
    }
  };
}
