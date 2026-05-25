import type { ScompMiddleware, ScompMiddlewareContext } from "./middleware";
import { getMiddlewareFns, runMiddlewareChain } from "./middleware";
import type { ITransport, ScompClientInvokeOptions } from "./transport";

/**
 * Wraps an ITransport, intercepting outbound request/signal/feed calls
 * with the given middleware chain.
 *
 * registerRoutes() and close() pass through to the inner transport.
 */
export function createMiddlewareTransport(inner: ITransport, middlewares: ScompMiddleware[]): ITransport {
  const outboundFns = getMiddlewareFns(middlewares, "outbound");

  if (outboundFns.length === 0) {
    return inner;
  }

  return {
    registerRoutes(router) {
      return inner.registerRoutes(router);
    },

    close() {
      return inner.close();
    },

    async request(route, payload, options?) {
      const ctx: ScompMiddlewareContext = {
        route,
        operation: "request",
        direction: "outbound",
        payload,
        meta: options?.meta,
      };

      return runMiddlewareChain(outboundFns, ctx, async (finalCtx) => {
        const finalOptions: ScompClientInvokeOptions | undefined = finalCtx.meta
          ? { ...options, meta: finalCtx.meta }
          : options;
        return inner.request(finalCtx.route, finalCtx.payload, finalOptions);
      });
    },

    async signal(route, payload, options?) {
      const ctx: ScompMiddlewareContext = {
        route,
        operation: "signal",
        direction: "outbound",
        payload,
        meta: options?.meta,
      };

      await runMiddlewareChain(outboundFns, ctx, async (finalCtx) => {
        const finalOptions: ScompClientInvokeOptions | undefined = finalCtx.meta
          ? { ...options, meta: finalCtx.meta }
          : options;
        await inner.signal(finalCtx.route, finalCtx.payload, finalOptions);
        return undefined;
      });
    },

    feed(route, payload, options?) {
      const ctx: ScompMiddlewareContext = {
        route,
        operation: "feed",
        direction: "outbound",
        payload,
        meta: options?.meta,
      };

      // Middleware wraps the subscription creation; individual chunks flow unchanged.
      const resultPromise = runMiddlewareChain(outboundFns, ctx, async (finalCtx) => {
        const finalOptions: ScompClientInvokeOptions | undefined = finalCtx.meta
          ? { ...options, meta: finalCtx.meta }
          : options;
        return inner.feed(finalCtx.route, finalCtx.payload, finalOptions);
      });

      return {
        async *[Symbol.asyncIterator]() {
          const iterable = (await resultPromise) as AsyncIterable<unknown>;
          yield* iterable;
        },
      };
    },
  };
}
