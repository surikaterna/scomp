import type { ScompMiddleware, ScompMiddlewareContext } from "./middleware";
import { getMiddlewareFns, runMiddlewareChain } from "./middleware";
import type { ITransport, ScompClientInvokeOptions } from "./transport";

/**
 * Wraps an ITransport, intercepting outbound invoke calls
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

    async invoke(route, payload, options?) {
      const ctx: ScompMiddlewareContext = {
        route,
        operation: "invoke",
        direction: "outbound",
        payload,
        meta: options?.meta,
      };

      return runMiddlewareChain(outboundFns, ctx, async (finalCtx) => {
        const finalOptions: ScompClientInvokeOptions | undefined = finalCtx.meta
          ? { ...options, meta: finalCtx.meta }
          : options;
        return inner.invoke(finalCtx.route, finalCtx.payload, finalOptions);
      });
    },
  };
}
