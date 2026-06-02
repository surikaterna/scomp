import type { ScompTransportMessageMeta } from "@scompr/types";

/**
 * Context provided to inbound handlers by transports.
 * Constructed from the wire envelope when a transport dispatches a request.
 */
export interface ScompHandlerContext {
  route: string;
  operation: "request" | "signal" | "feed" | "invoke";
  meta?: ScompTransportMessageMeta;
  [key: string]: unknown;
}

/**
 * Context passed through the middleware chain.
 * Read-only base fields, extensible via index signature for middleware state.
 */
export interface ScompMiddlewareContext {
  readonly route: string;
  readonly operation: "request" | "signal" | "feed" | "invoke";
  readonly direction: "inbound" | "outbound";
  payload: unknown;
  meta?: ScompTransportMessageMeta;
  [key: string]: unknown;
}

/**
 * A middleware function. Receives context and a next() function.
 * next() accepts an updated context — middleware passes modifications forward explicitly.
 */
export type ScompMiddlewareFn = (
  ctx: ScompMiddlewareContext,
  next: (ctx: ScompMiddlewareContext) => Promise<unknown>,
) => Promise<unknown>;

/**
 * A named middleware with optional inbound/outbound interceptors.
 */
export interface ScompMiddleware {
  name: string;
  /** Server-side: wraps inbound handler execution */
  inbound?: ScompMiddlewareFn;
  /** Client-side: wraps outbound transport calls */
  outbound?: ScompMiddlewareFn;
}

/**
 * Runs a chain of middleware functions (onion model), then calls the final handler.
 */
export function runMiddlewareChain(
  middlewares: ScompMiddlewareFn[],
  ctx: ScompMiddlewareContext,
  handler: (ctx: ScompMiddlewareContext) => Promise<unknown>,
): Promise<unknown> {
  function dispatch(i: number, currentCtx: ScompMiddlewareContext): Promise<unknown> {
    if (i >= middlewares.length) {
      return handler(currentCtx);
    }
    return middlewares[i](currentCtx, (nextCtx) => dispatch(i + 1, nextCtx));
  }

  return dispatch(0, ctx);
}

/**
 * Extracts middleware functions for a given direction from named middleware objects.
 */
export function getMiddlewareFns(
  middlewares: ScompMiddleware[],
  direction: "inbound" | "outbound",
): ScompMiddlewareFn[] {
  return middlewares
    .map((m) => (direction === "inbound" ? m.inbound : m.outbound))
    .filter((fn): fn is ScompMiddlewareFn => fn !== undefined);
}
