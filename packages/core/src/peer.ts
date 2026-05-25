import type { CompiledRoute, CompiledRouter, ServiceDefinition } from "./builder";
import { createScompService } from "./builder";
import type { ContractToken } from "./contract-token";
import {
  createNodeLocalDiscoverHandler,
  createNodeLocalHealthHandler,
  createNodeLocalResolveHandler,
} from "./control-plane";
import { ScompControlPlane } from "./control-plane-contract";
import type { ScompHandlerContext, ScompMiddleware, ScompMiddlewareContext, ScompMiddlewareFn } from "./middleware";
import { getMiddlewareFns, runMiddlewareChain } from "./middleware";
import { createMiddlewareTransport } from "./middleware-transport";
import type { ITransport } from "./transport";

/**
 * Factory that creates a typed client proxy from a transport and contract token.
 * Injected to avoid a circular dependency between @scomp/core and @scomp/client.
 */
export type ClientFactory = <C extends object>(transport: ITransport, token: ContractToken<C>) => C;

export interface IScompPeer {
  /** Register service definitions, merging their routers and pushing routes to all transports. */
  provides(...services: ServiceDefinition<object>[]): void;
  /** Obtain a typed client proxy for a consumed contract. Results are cached per token name. */
  consumes<C extends object>(token: ContractToken<C>): C;
  /** Close all transports and invalidate the peer. */
  close(): Promise<void>;
}

export interface CreateScompPeerConfig {
  transports: ITransport[];
  clientFactory: ClientFactory;
  /**
   * Controls automatic control-plane service registration.
   * - `true` (default): enables with an auto-generated nodeId.
   * - `{ nodeId: string }`: enables with the specified nodeId.
   * - `false`: disables the control plane entirely.
   */
  controlPlane?: boolean | { nodeId?: string };
  /** Middleware applied to outbound (client) transport calls. */
  middleware?: ScompMiddleware[];
}

function generateNodeId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `node-${timestamp}-${random}`;
}

function wrapRouteWithMiddleware(
  routeName: string,
  route: CompiledRoute,
  inboundFns: ScompMiddlewareFn[],
): CompiledRoute {
  const originalHandler = route.handler;
  return {
    ...route,
    handler: (payload: unknown, ctx?: ScompHandlerContext) => {
      const mwCtx: ScompMiddlewareContext = {
        route: routeName,
        operation: route.kind,
        direction: "inbound" as const,
        payload,
        meta: ctx?.meta,
      };
      return runMiddlewareChain(inboundFns, mwCtx, async (finalCtx) => {
        return originalHandler(finalCtx.payload, ctx);
      });
    },
  };
}

/**
 * Creates a peer that can both provide and consume scomp services.
 *
 * - `provides()` merges service routers and registers them on every transport.
 * - `consumes()` returns a cached client proxy backed by the first transport.
 * - `close()` tears down all transports; subsequent calls throw.
 * - When `controlPlane` is not `false`, auto-provides the control-plane service.
 */
export function createScompPeer(config: CreateScompPeerConfig): IScompPeer {
  const { transports, clientFactory, controlPlane = true, middleware = [] } = config;

  if (transports.length === 0) {
    throw new Error("createScompPeer requires at least one transport.");
  }

  let closed = false;
  const combinedRouter: CompiledRouter = {};
  const clientCache = new Map<string, unknown>();

  // Pre-compute inbound middleware fns once
  const inboundFns = getMiddlewareFns(middleware, "inbound");

  // Wrap transports with middleware for outbound (client) use
  const wrappedTransports =
    middleware.length > 0 ? transports.map((t) => createMiddlewareTransport(t, middleware)) : transports;

  function assertOpen(): void {
    if (closed) {
      throw new Error("Peer is closed.");
    }
  }

  function mergeServiceRouters(services: ServiceDefinition<object>[]): void {
    for (const service of services) {
      for (const routeName of Object.keys(service.router)) {
        if (combinedRouter[routeName] !== undefined) {
          throw new Error(`Duplicate route "${routeName}" from service "${service.name}".`);
        }
        combinedRouter[routeName] = service.router[routeName];
      }
    }
  }

  function applyInboundMiddleware(services: ServiceDefinition<object>[]): void {
    for (const service of services) {
      for (const routeName of Object.keys(service.router)) {
        combinedRouter[routeName] = wrapRouteWithMiddleware(routeName, combinedRouter[routeName], inboundFns);
      }
    }
  }

  function provides(...services: ServiceDefinition<object>[]): void {
    assertOpen();
    mergeServiceRouters(services);

    if (inboundFns.length > 0) {
      applyInboundMiddleware(services);
    }

    for (const transport of transports) {
      transport.registerRoutes(combinedRouter);
    }
  }

  function consumes<C extends object>(token: ContractToken<C>): C {
    assertOpen();

    const cached = clientCache.get(token.name);
    if (cached !== undefined) {
      return cached as C;
    }

    const proxy = clientFactory(wrappedTransports[0], token);
    clientCache.set(token.name, proxy);
    return proxy;
  }

  async function close(): Promise<void> {
    assertOpen();
    closed = true;
    clientCache.clear();

    const results = await Promise.allSettled(transports.map((t) => t.close()));

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
      const messages = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join("; ");
      throw new Error(`${failures.length} transport(s) failed to close: ${messages}`);
    }
  }

  // Auto-provide control-plane service when enabled.
  if (controlPlane !== false) {
    const nodeId = typeof controlPlane === "object" && controlPlane.nodeId ? controlPlane.nodeId : generateNodeId();

    // Handlers close over `combinedRouter`, so they see routes added later.
    const discoverHandler = createNodeLocalDiscoverHandler(combinedRouter, {
      nodeId,
    });
    const resolveHandler = createNodeLocalResolveHandler(combinedRouter);
    const healthHandler = createNodeLocalHealthHandler(combinedRouter, {
      nodeId,
    });

    const controlPlaneService = createScompService(ScompControlPlane).implement({
      discover: async (input) => discoverHandler(input),
      resolve: async (input) => resolveHandler(input),
      health: async (input) => healthHandler(input),
    });

    provides(controlPlaneService);
  }

  return { provides, consumes, close };
}
