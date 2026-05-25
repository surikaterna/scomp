import type { ScompTransportMessageMeta, ScompTransportPrincipal } from "@scomp/types";
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

type AuthOperation = "request" | "signal" | "feed";

async function resolveAuthPrincipal(
  config: AuthMiddlewareConfig,
  ctx: ScompMiddlewareContext,
): Promise<ScompTransportPrincipal | null | undefined> {
  if (!config.authenticate) {
    return undefined;
  }
  return config.authenticate({
    route: ctx.route,
    operation: ctx.operation as AuthOperation,
    payload: ctx.payload,
    meta: ctx.meta,
  });
}

async function enforceAuthorization(
  config: AuthMiddlewareConfig,
  ctx: ScompMiddlewareContext,
  principal: ScompTransportPrincipal | null | undefined,
): Promise<void> {
  if (!config.authorize) {
    return;
  }
  const allowed = await config.authorize({
    route: ctx.route,
    operation: ctx.operation as AuthOperation,
    payload: ctx.payload,
    meta: ctx.meta,
    principal: principal ?? undefined,
  });
  if (!allowed) {
    throw new ScompAuthError(`Not authorized for route: ${ctx.route}`);
  }
}

function buildAuthMeta(ctx: ScompMiddlewareContext, principal: ScompTransportPrincipal): ScompTransportMessageMeta {
  return {
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
  } as ScompTransportMessageMeta;
}

/**
 * Creates middleware that authenticates and authorizes requests.
 */
export function createAuthMiddleware(config: AuthMiddlewareConfig): ScompMiddleware {
  const hasAuthHooks = config.authenticate !== undefined || config.authorize !== undefined;

  return {
    name: "auth",
    inbound: async (ctx: ScompMiddlewareContext, next) => {
      const principal = await resolveAuthPrincipal(config, ctx);
      await enforceAuthorization(config, ctx, principal);
      return next({ ...ctx, principal: principal ?? undefined });
    },

    outbound: hasAuthHooks
      ? async (ctx: ScompMiddlewareContext, next) => {
          const principal = await resolveAuthPrincipal(config, ctx);
          await enforceAuthorization(config, ctx, principal);
          if (principal) {
            return next({ ...ctx, principal, meta: buildAuthMeta(ctx, principal) });
          }
          return next({ ...ctx, principal: principal ?? undefined });
        }
      : undefined,
  };
}
