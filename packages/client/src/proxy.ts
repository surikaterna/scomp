import {
  type ControlledAsyncIterable,
  createFeedHash,
  type ITransport,
  type ScompClientInvokeOptions,
  ScompFeed,
} from "@scomp/core";
import type {
  ContractRouteIntents,
  ScompPriorityClass,
  ScompPriorityHint,
  ScompTransportMessageMeta,
} from "@scomp/types";

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

export interface ClientRouteHints {
  [route: string]: "request" | "signal" | "feed";
}

export interface CreateScompClientConfig {
  transport: ITransport;
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
  operation: "request" | "signal" | "feed";
}) => ClientRouteOptionEntry | undefined;

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
  operation: "request" | "signal" | "feed",
  routeOptions: ClientRouteOptions | undefined,
  routeOptionResolver: ClientRouteOptionResolver | undefined,
): ResolvedInvocation {
  const callOptions = isRecord(callOptionsRaw) ? toInvokeOptions(callOptionsRaw as ScompClientCallOptions) : undefined;
  const routeDefault = normalizeRouteEntry(routeOptions?.[route]);
  const resolvedByResolver = normalizeRouteEntry(
    routeOptionResolver?.({
      route,
      payload,
      operation,
    }),
  );

  return {
    payload,
    options: mergeOptions(mergeOptions(routeDefault, resolvedByResolver), callOptions),
  };
}

function getRouteType(route: string, routeHints?: ClientRouteHints): "request" | "signal" | "feed" {
  return routeHints?.[route] ?? "request";
}

/**
 * Creates a JS Proxy that intercepts property access and dispatches
 * controller method calls as transport requests scoped to a feed.
 */
function createControllerProxy(transport: ITransport, route: string, feedId: string): unknown {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }

      return (payload: unknown) => {
        return transport.request(route, payload, {
          feed: feedId,
          method: prop,
        });
      };
    },
  });
}

/**
 * Wraps a transport feed async iterable with a controller proxy,
 * producing a {@link ScompControlledFeed}.
 */
function createControlledScompFeed(
  transport: ITransport,
  route: string,
  payload: unknown,
  options: ScompClientInvokeOptions | undefined,
): ScompControlledFeed<unknown, unknown> {
  const feedId = createFeedHash(route, payload);
  const feed = new ScompFeed(async function* feedGenerator() {
    for await (const chunk of transport.feed(route, payload, options)) {
      yield chunk;
    }
  });
  const controller = createControllerProxy(transport, route, feedId);

  return {
    [Symbol.asyncIterator]() {
      return feed[Symbol.asyncIterator]();
    },
    controller,
  };
}

function createProxyNode(
  transport: ITransport,
  routeHints: ClientRouteHints | undefined,
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

      return createProxyNode(transport, routeHints, routeOptions, routeOptionResolver, [...segments, prop]);
    },
    apply(_target, _thisArg, argArray: Array<unknown>) {
      const route = segments.join(".");
      const routeType = getRouteType(route, routeHints);
      const invocation = resolveInvocation(
        route,
        argArray[0],
        argArray[1],
        routeType,
        routeOptions,
        routeOptionResolver,
      );

      if (routeType === "signal") {
        return transport.signal(route, invocation.payload, invocation.options);
      }

      if (routeType === "feed") {
        return createControlledScompFeed(transport, route, invocation.payload, invocation.options);
      }

      return transport.request(route, invocation.payload, invocation.options);
    },
  });
}

export function createScompClient<Contract extends object>(
  config: CreateScompClientConfig,
): ScompClientProxy<Contract> {
  return createProxyNode(
    config.transport,
    config.routeHints,
    config.routeOptions,
    config.routeOptionResolver,
    [],
  ) as unknown as ScompClientProxy<Contract>;
}

export type ClientRouteIntentMap<Contract extends object> = ContractRouteIntents<Contract>;
