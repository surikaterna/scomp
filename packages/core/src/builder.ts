import type { ContractNetworkIntent } from "@scomp/types";
import type { ContractToken } from "./contract-token";
import type {
  CombinedFragmentMethodNames,
  CompiledRoute,
  CompiledRouter,
  EnsureNoDuplicateFragmentMethods,
  FragmentDefinition,
  FragmentMethodImplementations,
  GroupedFragmentMethodImplementations,
  GroupedMethodImplementationsInput,
  GroupedServiceMethodImplementations,
  IsValidContract,
  DiagnoseContract,
  ProvidedMethodKeys,
  ServiceDefinition,
  ServiceMethodImplementationsInput,
  StrictServiceImplementationChecks,
} from "./builder-types";

export type {
  CompiledRoute,
  CompiledRouter,
  DiagnoseContract,
  DiagnoseMethod,
  FeedImplementationConfig,
  FragmentDefinition,
  FragmentMethodImplementations,
  GroupedFragmentMethodImplementations,
  GroupedServiceMethodImplementations,
  IsValidContract,
  RequestImplementationConfig,
  ServiceDefinition,
  ServiceMethodImplementations,
  SignalImplementationConfig,
  ValidContract,
} from "./builder-types";

type RouteKind = "request" | "signal" | "feed";

function normalizeMethodConfig(
  methodConfig: unknown,
  inferredKind: RouteKind,
  deterministicKind: boolean,
): Omit<CompiledRoute, "route"> {
  if (typeof methodConfig === "function") {
    if (inferredKind === "feed") {
      return {
        kind: inferredKind,
        strategy: "exclusive",
        handler: methodConfig as (payload: unknown) => unknown,
      };
    }

    return {
      kind: inferredKind,
      handler: methodConfig as (payload: unknown) => unknown,
    };
  }

  const configObject = methodConfig as Record<string, unknown>;
  const kind = deterministicKind ? inferredKind : ((configObject.kind as RouteKind | undefined) ?? inferredKind);
  return {
    kind,
    parser: configObject.parser as ((payload: unknown) => unknown) | undefined,
    strategy: configObject.strategy as "fanout" | "exclusive" | undefined,
    hashKey: configObject.hashKey as ((payload: unknown) => string) | undefined,
    backpressure: configObject.backpressure as { highWaterMark?: number } | undefined,
    handler: configObject.handler as (payload: unknown) => unknown,
  };
}

function inferRouteKind(methodConfig: unknown): RouteKind {
  if (typeof methodConfig === "function") {
    return "request";
  }

  const configObject = methodConfig as Record<string, unknown>;
  if (configObject.kind === "signal" || configObject.kind === "request" || configObject.kind === "feed") {
    return configObject.kind;
  }

  if (typeof configObject.strategy === "string") {
    return "feed";
  }

  return "request";
}

function compileFlatRouter(name: string, methods: Record<string, unknown>): CompiledRouter {
  const router: CompiledRouter = {};

  for (const methodName of Object.keys(methods)) {
    const implementation = methods[methodName];
    const route = `${name}.${methodName}`;

    const inferredKind = inferRouteKind(implementation);
    const normalized = normalizeMethodConfig(implementation, inferredKind, false);

    router[route] = buildCompiledRoute(route, normalized);
  }

  return router;
}

function compileGroupedMethods(
  name: string,
  kind: RouteKind,
  methods: Record<string, unknown>,
  router: CompiledRouter,
) {
  for (const methodName of Object.keys(methods)) {
    const implementation = methods[methodName];
    const route = `${name}.${methodName}`;
    const normalized = normalizeMethodConfig(implementation, kind, true);

    router[route] = buildCompiledRoute(route, normalized);
  }
}

function buildCompiledRoute(route: string, normalized: Omit<CompiledRoute, "route">): CompiledRoute {
  return {
    route,
    kind: normalized.kind,
    parser: normalized.parser,
    strategy: normalized.strategy,
    hashKey: normalized.hashKey,
    backpressure: normalized.backpressure,
    handler: normalized.handler,
  };
}

function compileGroupedRouter<Contract extends object>(
  name: string,
  groupedMethods:
    | GroupedServiceMethodImplementations<Contract>
    | GroupedMethodImplementationsInput<Contract>
    | GroupedFragmentMethodImplementations<Contract>,
): CompiledRouter {
  const router: CompiledRouter = {};

  compileGroupedMethods(name, "request", (groupedMethods.requests ?? {}) as Record<string, unknown>, router);
  compileGroupedMethods(name, "signal", (groupedMethods.signals ?? {}) as Record<string, unknown>, router);
  compileGroupedMethods(name, "feed", (groupedMethods.feeds ?? {}) as Record<string, unknown>, router);

  return router;
}

function compileImplementationsRouter<Contract extends object>(
  name: string,
  methods:
    | ServiceMethodImplementationsInput<Contract>
    | FragmentMethodImplementations<Contract>
    | GroupedFragmentMethodImplementations<Contract>,
): CompiledRouter {
  return isGroupedMethods(methods)
    ? compileGroupedRouter(name, methods)
    : compileFlatRouter(name, methods as Record<string, unknown>);
}

function isGroupedMethods(methods: unknown): methods is {
  requests?: Record<string, unknown>;
  signals?: Record<string, unknown>;
  feeds?: Record<string, unknown>;
} {
  if (typeof methods !== "object" || methods === null) {
    return false;
  }

  const methodMap = methods as Record<string, unknown>;
  const methodKeys = Object.keys(methodMap);
  if (methodKeys.length === 0) {
    return false;
  }

  return methodKeys.every((key) => key === "requests" || key === "signals" || key === "feeds");
}

export function createScompService<Contract extends object>(
  token: ContractToken<Contract>,
  ..._errors: IsValidContract<Contract> extends true ? [] : [diagnosis: DiagnoseContract<Contract>]
) {
  const name = token.name;
  return {
    implement<Methods extends ServiceMethodImplementationsInput<Contract>>(
      methods: Methods & StrictServiceImplementationChecks<Contract, Methods>,
    ): ServiceDefinition<Contract> {
      const router = compileImplementationsRouter(name, methods);

      return {
        name,
        networkIntent: {} as ContractNetworkIntent<Contract>,
        router,
      };
    },
  };
}

export function createScompFragment<Contract extends object>(
  name: string,
  ..._errors: IsValidContract<Contract> extends true ? [] : [diagnosis: DiagnoseContract<Contract>]
) {
  return {
    implement<Methods extends FragmentMethodImplementations<Contract> | GroupedFragmentMethodImplementations<Contract>>(
      methods: Methods,
    ): FragmentDefinition<Contract, Extract<ProvidedMethodKeys<Methods>, string>> {
      const router = compileImplementationsRouter(name, methods);

      return {
        name,
        networkIntent: {} as Partial<ContractNetworkIntent<Contract>>,
        router,
      };
    },
  };
}

export function composeScompFragments<
  Contract extends object,
  Fragments extends readonly [FragmentDefinition<Contract, string>, ...Array<FragmentDefinition<Contract, string>>],
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
      const separatorIndex = routeName.indexOf(".");
      const methodName = separatorIndex === -1 ? routeName : routeName.slice(separatorIndex + 1);
      const existingSource = methodToSource.get(methodName);

      if (existingSource) {
        throw new Error(
          `Duplicate method "${methodName}" defined by fragments ${existingSource.fragmentLabel} (${existingSource.route}) and ${fragmentLabel} (${routeName})`,
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
    router,
  };
}
