import type {
  AnyContractMethod,
  ContractNetworkIntent,
  ContractMethodInput,
} from "@scomp/types";

// ---------------------------------------------------------------------------
// Contract validation types (compile-time only, zero runtime cost)
// ---------------------------------------------------------------------------

/**
 * Checks that every own property of `C` is a function.
 * Evaluates to `C` when valid, or maps non-function properties to `never`.
 *
 * Used as a self-referential constraint: `C extends ValidContract<C>`.
 * This avoids `Record<string, ...>` which interfaces cannot satisfy due to
 * missing implicit index signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ValidContract<C> = {
  [K in keyof C]: C[K] extends (...args: any[]) => unknown ? C[K] : never;
};

/**
 * Per-method diagnostic: produces a string-literal error when a method's
 * return type is not one of the supported kinds (Promise, AsyncIterable, void).
 */
export type DiagnoseMethod<K extends string, M> =
  M extends (...args: any[]) => infer R
    ? R extends Promise<unknown> | AsyncIterable<unknown> | void | Promise<void>
      ? M
      : `⚠ "${K}" must return Promise<T>, AsyncIterable<T>, or void`
    : `⚠ "${K}" is not a method`;

/**
 * Maps every method in a contract to either itself (valid) or a
 * descriptive string-literal error message (invalid return type).
 */
export type DiagnoseContract<C> = {
  [K in keyof C & string]: DiagnoseMethod<K, C[K]>;
};

/**
 * Evaluates to `true` when every method in the contract has a supported
 * return type and all properties are functions, `false` otherwise.
 */
export type IsValidContract<C extends object> =
  C extends ValidContract<C>
    ? DiagnoseContract<C> extends C
      ? true
      : false
    : false;

type RouteKind = "request" | "signal" | "feed";

export interface RequestImplementationConfig<Input, Output> {
  kind?: "request";
  parser?: (payload: unknown) => Input;
  handler: (input: Input) => Promise<Output>;
}

export interface SignalImplementationConfig<Input> {
  kind: "signal";
  parser?: (payload: unknown) => Input;
  handler: (input: Input) => void | Promise<void>;
}

export interface FeedImplementationConfig<Input, Output> {
  kind?: "feed";
  parser?: (payload: unknown) => Input;
  strategy: "fanout" | "exclusive";
  hashKey?: (input: Input) => string;
  backpressure?: {
    highWaterMark?: number;
  };
  handler: (input: Input) => AsyncIterable<Output>;
}

type ContractMethodKeys<Contract extends object> = {
  [MethodName in keyof Contract]: Contract[MethodName] extends AnyContractMethod
    ? MethodName
    : never;
}[keyof Contract];

type RequestRawHandler<Method> = Method extends (
  input: infer Input,
) => Promise<infer Output>
  ? (input: Input) => Promise<Output>
  : never;

type SignalRawHandler<Method> = Method extends (
  input: infer Input,
) => void | Promise<void>
  ? (input: Input) => void | Promise<void>
  : never;

type FeedRawHandler<Method> = Method extends (
  input: infer Input,
) => AsyncIterable<infer Output>
  ? (input: Input) => AsyncIterable<Output>
  : never;

type MethodKind<Method extends AnyContractMethod> =
  ReturnType<Method> extends AsyncIterable<unknown>
    ? "feed"
    : ReturnType<Method> extends void | Promise<void>
      ? "signal"
      : ReturnType<Method> extends Promise<unknown>
        ? "request"
        : never;

type RequestMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "request"
    ?
        | RequestRawHandler<Method>
        | RequestImplementationConfig<
            ContractMethodInput<Method>,
            Awaited<ReturnType<Method>>
          >
    : never;

type SignalMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "signal"
    ?
        | SignalRawHandler<Method>
        | SignalImplementationConfig<ContractMethodInput<Method>>
    : never;

type FeedMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "feed"
    ?
        | FeedRawHandler<Method>
        | FeedImplementationConfig<
            ContractMethodInput<Method>,
            ReturnType<Method> extends AsyncIterable<infer Output>
              ? Output
              : never
          >
    : never;

type GroupedRequestImplementationConfig<Input, Output> = Omit<
  RequestImplementationConfig<Input, Output>,
  "kind"
>;
type GroupedSignalImplementationConfig<Input> = Omit<
  SignalImplementationConfig<Input>,
  "kind"
>;
type GroupedFeedImplementationConfig<Input, Output> = Omit<
  FeedImplementationConfig<Input, Output>,
  "kind"
>;

type GroupedRequestMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "request"
    ?
        | RequestRawHandler<Method>
        | GroupedRequestImplementationConfig<
            ContractMethodInput<Method>,
            Awaited<ReturnType<Method>>
          >
    : never;

type GroupedSignalMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "signal"
    ?
        | SignalRawHandler<Method>
        | GroupedSignalImplementationConfig<ContractMethodInput<Method>>
    : never;

type GroupedFeedMethodImplementation<Method extends AnyContractMethod> =
  MethodKind<Method> extends "feed"
    ?
        | FeedRawHandler<Method>
        | GroupedFeedImplementationConfig<
            ContractMethodInput<Method>,
            ReturnType<Method> extends AsyncIterable<infer Output>
              ? Output
              : never
          >
    : never;

type ContractMethodKeysByKind<
  Contract extends object,
  Kind extends RouteKind,
> = {
  [MethodName in ContractMethodKeys<Contract>]: MethodKind<
    Extract<Contract[MethodName], AnyContractMethod>
  > extends Kind
    ? MethodName
    : never;
}[ContractMethodKeys<Contract>];

export type GroupedMethodImplementations<
  Contract extends object,
  Kind extends RouteKind,
> = {
  [MethodName in ContractMethodKeysByKind<
    Contract,
    Kind
  >]: Kind extends "request"
    ? GroupedRequestMethodImplementation<
        Extract<Contract[MethodName], AnyContractMethod>
      >
    : Kind extends "signal"
      ? GroupedSignalMethodImplementation<
          Extract<Contract[MethodName], AnyContractMethod>
        >
      : GroupedFeedMethodImplementation<
          Extract<Contract[MethodName], AnyContractMethod>
        >;
};

type MethodImplementation<Method extends AnyContractMethod> =
  | RequestMethodImplementation<Method>
  | SignalMethodImplementation<Method>
  | FeedMethodImplementation<Method>;

export type ServiceMethodImplementations<Contract extends object> = {
  [MethodName in ContractMethodKeys<Contract>]: MethodImplementation<
    Extract<Contract[MethodName], AnyContractMethod>
  >;
};

export type FragmentMethodImplementations<Contract extends object> = Partial<
  ServiceMethodImplementations<Contract>
>;

type FlatServiceMethodImplementationsInput<Contract extends object> = Partial<
  ServiceMethodImplementations<Contract>
>;

export interface GroupedServiceMethodImplementations<Contract extends object> {
  requests: GroupedMethodImplementations<Contract, "request">;
  signals: GroupedMethodImplementations<Contract, "signal">;
  feeds: GroupedMethodImplementations<Contract, "feed">;
}

/**
 * Partial grouped method implementations used by both services and fragments.
 *
 * Previously `GroupedServiceMethodImplementationsInput` and
 * `GroupedMethodImplementationsInput` were separate but structurally identical
 * types. They have been unified into this single interface.
 */
export interface GroupedMethodImplementationsInput<Contract extends object> {
  requests?: Partial<GroupedMethodImplementations<Contract, "request">>;
  signals?: Partial<GroupedMethodImplementations<Contract, "signal">>;
  feeds?: Partial<GroupedMethodImplementations<Contract, "feed">>;
}

export interface GroupedFragmentMethodImplementations<
  Contract extends object,
> extends GroupedMethodImplementationsInput<Contract> {}

export type ServiceMethodImplementationsInput<Contract extends object> =
  | FlatServiceMethodImplementationsInput<Contract>
  | GroupedMethodImplementationsInput<Contract>;

type GroupedProvidedMethodKeys<Grouped> = Grouped extends {
  requests?: infer Requests;
  signals?: infer Signals;
  feeds?: infer Feeds;
}
  ?
      | keyof NonNullable<Requests>
      | keyof NonNullable<Signals>
      | keyof NonNullable<Feeds>
  : never;

export type ProvidedMethodKeys<Methods> = Methods extends {
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

type EnsureKnownServiceMethods<Contract extends object, Methods> = [
  UnknownServiceMethodKeys<Contract, Methods>,
] extends [never]
  ? {}
  : {
      __scomp_unknown_methods__: {
        [MethodName in UnknownServiceMethodKeys<
          Contract,
          Methods
        >]: "Method is not in contract";
      };
    };

type EnsureCompleteServiceImplementation<Contract extends object, Methods> = [
  MissingServiceMethodKeys<Contract, Methods>,
] extends [never]
  ? {}
  : {
      __scomp_missing_methods__: {
        [MethodName in MissingServiceMethodKeys<
          Contract,
          Methods
        >]: "Missing contract implementation";
      };
    };

export type StrictServiceImplementationChecks<
  Contract extends object,
  Methods,
> = EnsureKnownServiceMethods<Contract, Methods> &
  EnsureCompleteServiceImplementation<Contract, Methods>;

export interface CompiledRoute {
  route: string;
  kind: RouteKind;
  parser?: (payload: unknown) => unknown;
  strategy?: "fanout" | "exclusive";
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

export interface FragmentDefinition<
  Contract extends object,
  Methods extends string = never,
> {
  name: string;
  networkIntent: Partial<ContractNetworkIntent<Contract>>;
  router: CompiledRouter;
  readonly __scomp_fragment_methods__?: Methods;
}

export type FragmentMethodNames<Fragment> =
  Fragment extends FragmentDefinition<object, infer Methods> ? Methods : never;

export type CombinedFragmentMethodNames<Fragments extends readonly unknown[]> =
  Fragments extends readonly [infer Fragment, ...infer Rest]
    ? FragmentMethodNames<Fragment> | CombinedFragmentMethodNames<Rest>
    : never;

type DuplicateFragmentMethodNames<
  Fragments extends readonly unknown[],
  Seen extends string = never,
  Duplicates extends string = never,
> = Fragments extends readonly [infer Fragment, ...infer Rest]
  ? DuplicateFragmentMethodNames<
      Rest,
      Seen | FragmentMethodNames<Fragment>,
      Duplicates | Extract<FragmentMethodNames<Fragment>, Seen>
    >
  : Duplicates;

export type EnsureNoDuplicateFragmentMethods<
  Fragments extends readonly unknown[],
> = [DuplicateFragmentMethodNames<Fragments>] extends [never]
  ? {}
  : {
      __scomp_duplicate_fragment_methods__: {
        [MethodName in DuplicateFragmentMethodNames<Fragments>]: "Duplicate method declared across fragments";
      };
    };
