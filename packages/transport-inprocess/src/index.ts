import type {
  CompiledRoute,
  CompiledRouter,
  ITransport,
  ScompClientInvokeOptions,
  ScompHandlerContext,
} from "@scomp/core";

/**
 * Configuration for {@link createInprocessTransport}.
 */
export interface InprocessTransportConfig {
  /**
   * Optional error sink for signal (fire-and-forget) failures.
   * If omitted, asynchronous signal failures are re-thrown in a microtask.
   */
  onSignalError?: (error: unknown, route: string) => void;
}

function resolveRoute(router: CompiledRouter | undefined, route: string): CompiledRoute {
  if (!router) {
    throw new Error("No routes registered. Call registerRoutes() before invoking methods.");
  }

  const compiledRoute = router[route];
  if (!compiledRoute) {
    throw new Error(`Route "${route}" not found in registered routes.`);
  }

  return compiledRoute;
}

function invokeHandler(compiledRoute: CompiledRoute, payload: unknown, ctx?: ScompHandlerContext): unknown {
  const parsed = compiledRoute.parser ? compiledRoute.parser(payload) : payload;
  return compiledRoute.handler(parsed, ctx);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * Creates an in-process transport that directly invokes service handlers
 * within the same process, implementing the {@link ITransport} interface.
 */
export function createInprocessTransport(config: InprocessTransportConfig = {}): ITransport {
  let router: CompiledRouter | undefined;

  return {
    registerRoutes(incoming: Record<string, unknown>): void {
      router = incoming as CompiledRouter;
    },

    close(): void {
      router = undefined;
    },

    async request(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
      const compiledRoute = resolveRoute(router, route);

      if (compiledRoute.kind === "feed") {
        throw new Error(`Route "${route}" is a feed and cannot be used as request/response.`);
      }

      const ctx: ScompHandlerContext = { route, operation: compiledRoute.kind, meta: options?.meta };
      return Promise.resolve(invokeHandler(compiledRoute, payload, ctx));
    },

    async signal(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<void> {
      const compiledRoute = resolveRoute(router, route);

      try {
        const ctx: ScompHandlerContext = { route, operation: compiledRoute.kind, meta: options?.meta };
        const result = invokeHandler(compiledRoute, payload, ctx);

        void Promise.resolve(result).catch((error) => {
          if (config.onSignalError) {
            config.onSignalError(error, route);
            return;
          }

          queueMicrotask(() => {
            throw error;
          });
        });
      } catch (error) {
        if (config.onSignalError) {
          config.onSignalError(error, route);
          return;
        }

        throw error;
      }
    },

    feed(route: string, payload: unknown, options?: ScompClientInvokeOptions): AsyncIterable<unknown> {
      const compiledRoute = resolveRoute(router, route);

      if (compiledRoute.kind !== "feed") {
        throw new Error(`Route "${route}" is not a feed route (kind: "${compiledRoute.kind}").`);
      }

      const ctx: ScompHandlerContext = { route, operation: compiledRoute.kind, meta: options?.meta };
      const result = invokeHandler(compiledRoute, payload, ctx);

      if (isAsyncIterable(result)) {
        return result;
      }

      throw new Error(`Feed handler for route "${route}" did not return an AsyncIterable.`);
    },
  };
}
