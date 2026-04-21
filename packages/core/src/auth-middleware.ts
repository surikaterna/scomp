import type { ScompTransportPrincipal, ScompTransportMessageMeta } from "@scomp/types";
import type { ScompMiddleware, ScompMiddlewareContext } from "./middleware";

export interface AuthMiddlewareConfig {
  /**
   * Extract a principal from the request context.
   * Return null/undefined to indicate authentication failure.
   */
  authenticate?: (context: {
    route: string;
    operation: "request" | "signal" | "feed";
    payload: unknown;
    meta?: ScompTransportMessageMeta;
  }) => ScompTransportPrincipal | null | Promise<ScompTransportPrincipal | null>;

  /**
   * Check if the authenticated principal is authorized for this operation.
   * Return false to reject the request.
   */
  authorize?: (context: {
    route: string;
    operation: "request" | "signal" | "feed";
    payload: unknown;
    meta?: ScompTransportMessageMeta;
    principal?: ScompTransportPrincipal;
  }) => boolean | Promise<boolean>;
}

/**
 * Error thrown by auth middleware when authentication or authorization fails.
 * Transports should detect this error code to return UNAUTHORIZED responses.
 */
export class ScompAuthError extends Error {
  readonly code = "UNAUTHORIZED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScompAuthError";
  }
}

/**
 * Creates an inbound middleware that authenticates and authorizes requests.
 * Creates middleware that authenticates and authorizes requests.
 */
export function createAuthMiddleware(config: AuthMiddlewareConfig): ScompMiddleware {
  const hasAuthHooks = config.authenticate !== undefined || config.authorize !== undefined;

  return {
    name: "auth",
    inbound: async (ctx: ScompMiddlewareContext, next) => {
      const principal = config.authenticate
        ? await config.authenticate({
            route: ctx.route,
            operation: ctx.operation as "request" | "signal" | "feed",
            payload: ctx.payload,
            meta: ctx.meta,
          })
        : undefined;

      if (config.authorize) {
        const allowed = await config.authorize({
          route: ctx.route,
          operation: ctx.operation as "request" | "signal" | "feed",
          payload: ctx.payload,
          meta: ctx.meta,
          principal: principal ?? undefined,
        });
        if (!allowed) {
          throw new ScompAuthError(
            `Not authorized for route: ${ctx.route}`,
          );
        }
      }

      // Pass principal downstream in context
      return next({ ...ctx, principal: principal ?? undefined });
    },

    // Only set outbound if there are auth hooks to run
    outbound: hasAuthHooks
      ? async (ctx: ScompMiddlewareContext, next) => {
          const principal = config.authenticate
            ? await config.authenticate({
                route: ctx.route,
                operation: ctx.operation as "request" | "signal" | "feed",
                payload: ctx.payload,
                meta: ctx.meta,
              })
            : undefined;

          if (config.authorize) {
            const allowed = await config.authorize({
              route: ctx.route,
              operation: ctx.operation as "request" | "signal" | "feed",
              payload: ctx.payload,
              meta: ctx.meta,
              principal: principal ?? undefined,
            });
            if (!allowed) {
              throw new ScompAuthError(
                `Not authorized for route: ${ctx.route}`,
              );
            }
          }

          // Inject principal into outbound meta so the server can see it
          if (principal) {
            const updatedMeta = {
              ...ctx.meta,
              auth: {
                subject: principal.subject,
                tenantId: principal.tenantId,
                scopes: principal.scopes,
                claims: principal.claims,
                issuedAt: principal.issuedAt,
                expiresAt: principal.expiresAt,
                authType: principal.authType,
              },
              ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
            };
            return next({ ...ctx, principal, meta: updatedMeta });
          }

          return next({ ...ctx, principal: principal ?? undefined });
        }
      : undefined,
  };
}
