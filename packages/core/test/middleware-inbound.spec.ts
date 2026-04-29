import { describe, it, expect, vi } from "vitest";
import {
  runMiddlewareChain,
  getMiddlewareFns,
  type ScompMiddleware,
  type ScompMiddlewareContext,
  type ScompHandlerContext,
} from "../src/middleware";
import { createAuthMiddleware, ScompAuthError } from "../src/auth-middleware";
import type { CompiledRoute, CompiledRouter } from "../src/builder-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Partial<CompiledRoute> = {}): CompiledRoute {
  return {
    route: "TestService.echo",
    kind: "request",
    handler: async (payload: unknown) => payload,
    ...overrides,
  };
}

function _makeRouter(routes: Record<string, Partial<CompiledRoute>> = {}): CompiledRouter {
  const router: CompiledRouter = {};
  for (const [name, overrides] of Object.entries(routes)) {
    router[name] = makeRoute({ route: name, ...overrides });
  }
  return router;
}

// ---------------------------------------------------------------------------
// Inbound middleware wrapping
// ---------------------------------------------------------------------------

describe("inbound middleware", () => {
  it("middleware chain executes for inbound direction", async () => {
    const calls: string[] = [];
    const mw: ScompMiddleware = {
      name: "logger",
      inbound: async (ctx, next) => {
        calls.push("before");
        const result = await next(ctx);
        calls.push("after");
        return result;
      },
    };

    const fns = getMiddlewareFns([mw], "inbound");
    expect(fns).toHaveLength(1);

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "hello",
    };

    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("hello");
    expect(calls).toEqual(["before", "after"]);
  });

  it("middleware can modify payload", async () => {
    const mw: ScompMiddleware = {
      name: "transform",
      inbound: async (ctx, next) => {
        return next({ ...ctx, payload: String(ctx.payload).toUpperCase() });
      },
    };

    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "hello",
    };

    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("HELLO");
  });

  it("middleware can short-circuit (reject)", async () => {
    const mw: ScompMiddleware = {
      name: "blocker",
      inbound: async (_ctx, _next) => {
        throw new Error("blocked");
      },
    };

    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "hello",
    };

    await expect(runMiddlewareChain(fns, ctx, async (c) => c.payload)).rejects.toThrow("blocked");
  });

  it("multiple inbound middleware compose correctly", async () => {
    const order: number[] = [];
    const mw1: ScompMiddleware = {
      name: "first",
      inbound: async (ctx, next) => {
        order.push(1);
        const result = await next(ctx);
        order.push(4);
        return result;
      },
    };
    const mw2: ScompMiddleware = {
      name: "second",
      inbound: async (ctx, next) => {
        order.push(2);
        const result = await next(ctx);
        order.push(3);
        return result;
      },
    };

    const fns = getMiddlewareFns([mw1, mw2], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "data",
    };

    await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("inbound and outbound middleware are independent", () => {
    const mw: ScompMiddleware = {
      name: "dual",
      inbound: async (ctx, next) => next(ctx),
      outbound: async (ctx, next) => next(ctx),
    };

    const inFns = getMiddlewareFns([mw], "inbound");
    const outFns = getMiddlewareFns([mw], "outbound");
    expect(inFns).toHaveLength(1);
    expect(outFns).toHaveLength(1);
    expect(inFns[0]).not.toBe(outFns[0]);
  });
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe("createAuthMiddleware", () => {
  it("allows calls when no authenticate/authorize configured", async () => {
    const mw = createAuthMiddleware({});
    const fns = getMiddlewareFns([mw], "inbound");
    expect(fns).toHaveLength(1);

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "hello",
    };

    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("hello");
  });

  it("authenticate is called with correct context", async () => {
    const authenticate = vi.fn().mockResolvedValue({ id: "user-1", roles: ["admin"] });
    const mw = createAuthMiddleware({ authenticate });
    const fns = getMiddlewareFns([mw], "inbound");

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: { data: 42 },
      meta: { traceId: "t-1" },
    };

    await runMiddlewareChain(fns, ctx, async (c) => c.payload);

    expect(authenticate).toHaveBeenCalledWith({
      route: "Test.echo",
      operation: "request",
      payload: { data: 42 },
      meta: { traceId: "t-1" },
    });
  });

  it("authorize is called with principal", async () => {
    const principal = { id: "user-1", roles: ["admin"] };
    const authenticate = vi.fn().mockResolvedValue(principal);
    const authorize = vi.fn().mockResolvedValue(true);

    const mw = createAuthMiddleware({ authenticate, authorize });
    const fns = getMiddlewareFns([mw], "inbound");

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "data",
    };

    await runMiddlewareChain(fns, ctx, async (c) => c.payload);

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ principal }));
  });

  it("throws ScompAuthError when authorize returns false", async () => {
    const mw = createAuthMiddleware({
      authorize: () => false,
    });
    const fns = getMiddlewareFns([mw], "inbound");

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "data",
    };

    await expect(runMiddlewareChain(fns, ctx, async (c) => c.payload)).rejects.toThrow(ScompAuthError);
  });

  it("ScompAuthError has correct code property", () => {
    const err = new ScompAuthError("test");
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.name).toBe("ScompAuthError");
    expect(err.message).toBe("test");
  });

  it("principal is passed downstream in context via next()", async () => {
    const principal = { id: "user-1", roles: [] };
    const mw = createAuthMiddleware({
      authenticate: () => principal,
    });
    const fns = getMiddlewareFns([mw], "inbound");

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "data",
    };

    let capturedCtx: ScompMiddlewareContext | undefined;
    await runMiddlewareChain(fns, ctx, async (c) => {
      capturedCtx = c;
      return c.payload;
    });

    expect(capturedCtx?.principal).toEqual(principal);
  });

  it("denies unauthorized signal operations", async () => {
    const mw = createAuthMiddleware({ authorize: () => false });
    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.notify",
      operation: "signal",
      direction: "inbound",
      payload: "data",
    };
    await expect(runMiddlewareChain(fns, ctx, async (c) => c.payload)).rejects.toThrow(ScompAuthError);
  });

  it("denies unauthorized feed operations", async () => {
    const mw = createAuthMiddleware({ authorize: () => false });
    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.stream",
      operation: "feed",
      direction: "inbound",
      payload: "data",
    };
    await expect(runMiddlewareChain(fns, ctx, async (c) => c.payload)).rejects.toThrow(ScompAuthError);
  });

  it("allows authorized signal operations", async () => {
    const mw = createAuthMiddleware({ authorize: () => true });
    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.notify",
      operation: "signal",
      direction: "inbound",
      payload: "data",
    };
    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("data");
  });

  it("allows authorized feed operations", async () => {
    const mw = createAuthMiddleware({ authorize: () => true });
    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.stream",
      operation: "feed",
      direction: "inbound",
      payload: "data",
    };
    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("data");
  });

  it("outbound: injects principal into meta", async () => {
    const principal = {
      subject: "user-1",
      tenantId: "tenant-a",
      scopes: ["read"],
      claims: {},
      authType: "jwt",
    };
    const mw = createAuthMiddleware({
      authenticate: () => principal,
    });
    const fns = getMiddlewareFns([mw], "outbound");
    expect(fns).toHaveLength(1);

    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "outbound",
      payload: "data",
    };

    let capturedCtx: ScompMiddlewareContext | undefined;
    await runMiddlewareChain(fns, ctx, async (c) => {
      capturedCtx = c;
      return c.payload;
    });

    expect(capturedCtx?.meta).toBeDefined();
    expect((capturedCtx?.meta as Record<string, unknown>)?.auth).toEqual({
      subject: "user-1",
      tenantId: "tenant-a",
      scopes: ["read"],
      claims: {},
      issuedAt: undefined,
      expiresAt: undefined,
      authType: "jwt",
    });
    expect(capturedCtx?.principal).toEqual(principal);
  });

  it("outbound: denies unauthorized outbound calls", async () => {
    const mw = createAuthMiddleware({ authorize: () => false });
    const fns = getMiddlewareFns([mw], "outbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "outbound",
      payload: "data",
    };
    await expect(runMiddlewareChain(fns, ctx, async (c) => c.payload)).rejects.toThrow(ScompAuthError);
  });

  it("outbound: passes through when no auth hooks configured", () => {
    const mw = createAuthMiddleware({});
    const fns = getMiddlewareFns([mw], "outbound");
    expect(fns).toHaveLength(0);
  });

  it("works with async authenticate/authorize", async () => {
    const mw = createAuthMiddleware({
      authenticate: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: "async-user", roles: ["viewer"] };
      },
      authorize: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return true;
      },
    });

    const fns = getMiddlewareFns([mw], "inbound");
    const ctx: ScompMiddlewareContext = {
      route: "Test.echo",
      operation: "request",
      direction: "inbound",
      payload: "data",
    };

    const result = await runMiddlewareChain(fns, ctx, async (c) => c.payload);
    expect(result).toBe("data");
  });
});

// ---------------------------------------------------------------------------
// Handler context passthrough
// ---------------------------------------------------------------------------

describe("handler context passthrough", () => {
  it("CompiledRoute handler accepts optional context parameter", () => {
    const route = makeRoute({
      handler: (payload: unknown, ctx?: ScompHandlerContext) => {
        return { payload, ctx };
      },
    });

    const result = route.handler("data", {
      route: "Test.echo",
      operation: "request",
      meta: { traceId: "t-1" },
    });
    expect(result).toEqual({
      payload: "data",
      ctx: { route: "Test.echo", operation: "request", meta: { traceId: "t-1" } },
    });
  });

  it("handler works without context (backward compatible)", () => {
    const route = makeRoute({
      handler: (payload: unknown) => payload,
    });

    const result = route.handler("data");
    expect(result).toBe("data");
  });
});
