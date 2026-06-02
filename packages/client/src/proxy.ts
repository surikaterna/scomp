import type {
  ControlledAsyncIterable,
  ITransport,
  RouteKindMap,
  ScompClientInvokeOptions,
  ScompFeed,
} from "@scompr/core";
import type {
  ContractRouteIntents,
  ScompPriorityClass,
  ScompPriorityHint,
  ScompTransportMessageMeta,
} from "@scompr/types";
import { createScompResult } from "./scomp-result";

type UnknownFunction = (...args: Array<unknown>) => unknown;

/**
 * Client-side representation of a controlled feed.
 * Async-iterable for consuming values, with a `.controller` proxy for
 * dispatching controller method calls back to the server.
 */
export interface ScompControlledFeed<T, C> extends AsyncIterable<T> {
  readonly controller: C;
}

/**
 * Extracts the controller type from a `ControlledAsyncIterable` return type.
 * Maps each controller method to return `Promise<Awaited<ReturnType>>`.
 */
type ClientControllerProxy<C> = {
  [K in keyof C]: C[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export type ScompClientProxy<Contract extends object> = {
  [Key in keyof Contract]: Contract[Key] extends (
    ...args: infer Args
  ) => ControlledAsyncIterable<infer Output, infer Controller>
    ? (...args: [...Args, ScompClientCallOptions?]) => ScompControlledFeed<Output, ClientControllerProxy<Controller>>
    : Contract[Key] extends (...args: infer Args) => AsyncIterable<infer Output>
      ? (...args: [...Args, ScompClientCallOptions?]) => ScompFeed<Output>
      : Contract[Key] extends (...args: infer Args) => void | Promise<void>
        ? (...args: [...Args, ScompClientCallOptions?]) => Promise<void>
        : Contract[Key] extends (...args: infer Args) => Promise<infer Output>
          ? (...args: [...Args, ScompClientCallOptions?]) => Promise<Output>
          : Contract[Key] extends object
            ? ScompClientProxy<Contract[Key]>
            : never;
};

export interface CreateScompClientConfig {
  transport: ITransport;
  /** @deprecated Route hints are no longer needed — invoke() handles dispatch automatically. */
  routeHints?: ClientRouteHints;
  routeOptions?: ClientRouteOptions;
  routeOptionResolver?: ClientRouteOptionResolver;
}

export interface ScompClientCallOptions {
  meta?: ScompTransportMessageMeta;
  priority?: ScompPriorityHint;
  priorityClass?: ScompPriorityClass;
  deadlineAtMs?: number;
  targetLatencyMs?: number;
}

export interface ClientRouteOptionEntry {
  meta?: ScompTransportMessageMeta;
  priority?: ScompPriorityHint;
  priorityClass?: ScompPriorityClass;
  deadlineAtMs?: number;
  targetLatencyMs?: number;
}

export interface ClientRouteOptions {
  [route: string]: ClientRouteOptionEntry;
}

export type ClientRouteOptionResolver = (context: {
  route: string;
  payload: unknown;
  operation: "request" | "signal" | "feed" | "invoke";
}) => ClientRouteOptionEntry | undefined;

/** @deprecated Route hints are no longer needed — invoke() handles dispatch automatically. */
export interface ClientRouteHints {
  [route: string]: "request" | "signal" | "feed";
}

interface ResolvedInvocation {
  payload: unknown;
  options?: ScompClientInvokeOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRouteEntry(entry?: ClientRouteOptionEntry): ScompClientInvokeOptions | undefined {
  if (!entry) {
    return undefined;
  }

  const options: ScompClientInvokeOptions = {};
  if (entry.meta !== undefined) {
    options.meta = entry.meta;
  }
  if (entry.priority !== undefined) {
    options.priority = entry.priority;
  }
  if (entry.priorityClass !== undefined) {
    options.priorityClass = entry.priorityClass;
  }
  if (entry.deadlineAtMs !== undefined) {
    options.deadlineAtMs = entry.deadlineAtMs;
  }
  if (entry.targetLatencyMs !== undefined) {
    options.targetLatencyMs = entry.targetLatencyMs;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function mergeOptions(
  base: ScompClientInvokeOptions | undefined,
  override: ScompClientInvokeOptions | undefined,
): ScompClientInvokeOptions | undefined {
  if (!base && !override) {
    return undefined;
  }

  const mergedMeta = {
    ...(base?.meta ?? {}),
    ...(override?.meta ?? {}),
  };
  const hasMeta = Object.keys(mergedMeta).length > 0;

  const merged: ScompClientInvokeOptions = {
    ...(base ?? {}),
    ...(override ?? {}),
  };

  if (hasMeta) {
    merged.meta = mergedMeta;
  } else {
    delete merged.meta;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function toInvokeOptions(callOptions?: ScompClientCallOptions): ScompClientInvokeOptions | undefined {
  if (!callOptions) {
    return undefined;
  }

  const options: ScompClientInvokeOptions = {};
  if (callOptions.meta !== undefined) {
    options.meta = callOptions.meta;
  }
  if (callOptions.priority !== undefined) {
    options.priority = callOptions.priority;
  }
  if (callOptions.priorityClass !== undefined) {
    options.priorityClass = callOptions.priorityClass;
  }
  if (callOptions.deadlineAtMs !== undefined) {
    options.deadlineAtMs = callOptions.deadlineAtMs;
  }
  if (callOptions.targetLatencyMs !== undefined) {
    options.targetLatencyMs = callOptions.targetLatencyMs;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function resolveInvocation(
  route: string,
  payload: unknown,
  callOptionsRaw: unknown,
  routeOptions: ClientRouteOptions | undefined,
  routeOptionResolver: ClientRouteOptionResolver | undefined,
): ResolvedInvocation {
  const callOptions = isRecord(callOptionsRaw) ? toInvokeOptions(callOptionsRaw as ScompClientCallOptions) : undefined;
  const routeDefault = normalizeRouteEntry(routeOptions?.[route]);
  const resolvedByResolver = normalizeRouteEntry(
    routeOptionResolver?.({
      route,
      payload,
      operation: "invoke",
    }),
  );

  return {
    payload,
    options: mergeOptions(mergeOptions(routeDefault, resolvedByResolver), callOptions),
  };
}

function createProxyNode(
  transport: ITransport,
  routeOptions: ClientRouteOptions | undefined,
  routeOptionResolver: ClientRouteOptionResolver | undefined,
  segments: Array<string>,
): UnknownFunction {
  const target = () => {
    return undefined;
  };

  return new Proxy(target, {
    get(_target, prop, _receiver) {
      if (typeof prop !== "string") {
        return undefined;
      }

      return createProxyNode(transport, routeOptions, routeOptionResolver, [...segments, prop]);
    },
    apply(_target, _thisArg, argArray: Array<unknown>) {
      const route = segments.join(".");
      const invocation = resolveInvocation(route, argArray[0], argArray[1], routeOptions, routeOptionResolver);

      const promise = transport.invoke(route, invocation.payload, invocation.options);
      return createScompResult(promise);
    },
  });
}

export function createScompClient<Contract extends object>(
  config: CreateScompClientConfig,
): ScompClientProxy<Contract> {
  return createProxyNode(
    config.transport,
    config.routeOptions,
    config.routeOptionResolver,
    [],
  ) as unknown as ScompClientProxy<Contract>;
}

export type ClientRouteIntentMap<Contract extends object> = ContractRouteIntents<Contract>;

/**
 * Creates a {@link ClientFactory}-compatible function for use with `createScompPeer`.
 *
 * The returned factory uses the unified invoke() method on the transport,
 * eliminating the need for route hints or kind mappings at the client level.
 */
export function createClientFactory(options?: {
  routeOptions?: ClientRouteOptions;
  routeOptionResolver?: ClientRouteOptionResolver;
}): <C extends object>(transport: ITransport, token: { name: string }, routeKinds?: RouteKindMap) => C {
  return <C extends object>(transport: ITransport, token: { name: string }, _routeKinds?: RouteKindMap): C => {
    return createProxyNode(transport, options?.routeOptions, options?.routeOptionResolver, [
      token.name,
    ]) as unknown as C;
  };
}
