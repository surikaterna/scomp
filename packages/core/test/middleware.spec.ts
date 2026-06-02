import assert from "node:assert/strict";
import {
  runMiddlewareChain,
  getMiddlewareFns,
  createMiddlewareTransport,
  createScompPeer,
  createContractToken,
} from "../src";
import type { ScompMiddlewareContext, ScompMiddlewareFn, ScompMiddleware, ITransport, CompiledRouter } from "../src";

/* ---------- helpers ---------- */

function makeCtx(overrides: Partial<ScompMiddlewareContext> = {}): ScompMiddlewareContext {
  return {
    route: "test.route",
    operation: "request",
    direction: "outbound",
    payload: { hello: "world" },
    ...overrides,
  };
}

function createFakeTransport(overrides: Partial<ITransport> = {}): ITransport & {
  registeredRouter: CompiledRouter | undefined;
  closeCalled: boolean;
  invokeCalls: Array<{ route: string; payload: unknown; options?: unknown }>;
} {
  const fake = {
    registeredRouter: undefined as CompiledRouter | undefined,
    closeCalled: false,
    invokeCalls: [] as Array<{ route: string; payload: unknown; options?: unknown }>,
    registerRoutes(router: Record<string, unknown>) {
      fake.registeredRouter = router as CompiledRouter;
    },
    close() {
      fake.closeCalled = true;
      return overrides.close?.() ?? Promise.resolve();
    },
    invoke:
      overrides.invoke ??
      (async (route: string, payload: unknown, options?: unknown) => {
        fake.invokeCalls.push({ route, payload, options });
        return { result: "ok" };
      }),
  };
  return fake;
}

function stubClientFactory() {
  const calls: Array<{ transport: ITransport; tokenName: string }> = [];
  function factory<C extends object>(transport: ITransport, token: { name: string }): C {
    calls.push({ transport, tokenName: token.name });
    return { __stub: token.name } as unknown as C;
  }
  return { factory, calls };
}

/* ---------- runMiddlewareChain ---------- */

describe("runMiddlewareChain", () => {
  it("calls handler directly when no middleware", async () => {
    const ctx = makeCtx();
    const result = await runMiddlewareChain([], ctx, async (c) => c.payload);
    assert.deepEqual(result, { hello: "world" });
  });

  it("executes middleware in order (onion model)", async () => {
    const order: string[] = [];

    const mw1: ScompMiddlewareFn = async (ctx, next) => {
      order.push("mw1-before");
      const result = await next(ctx);
      order.push("mw1-after");
      return result;
    };
    const mw2: ScompMiddlewareFn = async (ctx, next) => {
      order.push("mw2-before");
      const result = await next(ctx);
      order.push("mw2-after");
      return result;
    };

    await runMiddlewareChain([mw1, mw2], makeCtx(), async () => {
      order.push("handler");
      return "done";
    });

    assert.deepEqual(order, ["mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"]);
  });

  it("middleware can modify context via next()", async () => {
    const mw: ScompMiddlewareFn = async (ctx, next) => {
      return next({ ...ctx, payload: "modified" });
    };

    const result = await runMiddlewareChain([mw], makeCtx(), async (c) => c.payload);
    assert.equal(result, "modified");
  });

  it("middleware can modify the response", async () => {
    const mw: ScompMiddlewareFn = async (ctx, next) => {
      const result = await next(ctx);
      return { wrapped: result };
    };

    const result = await runMiddlewareChain([mw], makeCtx(), async () => "inner");
    assert.deepEqual(result, { wrapped: "inner" });
  });

  it("middleware can short-circuit", async () => {
    const mw: ScompMiddlewareFn = async () => "short-circuited";
    let handlerCalled = false;

    const result = await runMiddlewareChain([mw], makeCtx(), async () => {
      handlerCalled = true;
      return "should not reach";
    });

    assert.equal(result, "short-circuited");
    assert.equal(handlerCalled, false);
  });

  it("middleware can catch and rethrow errors", async () => {
    const mw: ScompMiddlewareFn = async (ctx, next) => {
      try {
        return await next(ctx);
      } catch (err) {
        throw new Error(`wrapped: ${(err as Error).message}`);
      }
    };

    await assert.rejects(
      () =>
        runMiddlewareChain([mw], makeCtx(), async () => {
          throw new Error("boom");
        }),
      { message: "wrapped: boom" },
    );
  });

  it("handler receives final modified context", async () => {
    const mw1: ScompMiddlewareFn = async (ctx, next) => {
      return next({ ...ctx, payload: "from-mw1" });
    };
    const mw2: ScompMiddlewareFn = async (ctx, next) => {
      return next({ ...ctx, payload: `${ctx.payload}-from-mw2` });
    };

    const result = await runMiddlewareChain([mw1, mw2], makeCtx(), async (c) => c.payload);
    assert.equal(result, "from-mw1-from-mw2");
  });
});

/* ---------- getMiddlewareFns ---------- */

describe("getMiddlewareFns", () => {
  it("extracts inbound functions", () => {
    const inFn: ScompMiddlewareFn = async (ctx, next) => next(ctx);
    const mws: ScompMiddleware[] = [
      { name: "a", inbound: inFn },
      { name: "b", outbound: async (ctx, next) => next(ctx) },
      { name: "c", inbound: inFn },
    ];
    const fns = getMiddlewareFns(mws, "inbound");
    assert.equal(fns.length, 2);
    assert.equal(fns[0], inFn);
    assert.equal(fns[1], inFn);
  });

  it("extracts outbound functions", () => {
    const outFn: ScompMiddlewareFn = async (ctx, next) => next(ctx);
    const mws: ScompMiddleware[] = [
      { name: "a", outbound: outFn },
      { name: "b", inbound: async (ctx, next) => next(ctx) },
    ];
    const fns = getMiddlewareFns(mws, "outbound");
    assert.equal(fns.length, 1);
    assert.equal(fns[0], outFn);
  });
});

/* ---------- createMiddlewareTransport ---------- */

describe("createMiddlewareTransport", () => {
  it("returns inner transport when no outbound middleware", () => {
    const inner = createFakeTransport();
    const mws: ScompMiddleware[] = [{ name: "inbound-only", inbound: async (ctx, next) => next(ctx) }];
    const wrapped = createMiddlewareTransport(inner, mws);
    assert.equal(wrapped, inner);
  });

  it("intercepts invoke() calls", async () => {
    const inner = createFakeTransport();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => {
        return next({ ...ctx, payload: "intercepted" });
      },
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    await wrapped.invoke("r", "original");

    assert.equal(inner.invokeCalls.length, 1);
    assert.equal(inner.invokeCalls[0].payload, "intercepted");
  });

  it("intercepts invoke() for signal-like calls", async () => {
    const inner = createFakeTransport();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next({ ...ctx, payload: "sig-intercepted" }),
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    await wrapped.invoke("r", "original");

    assert.equal(inner.invokeCalls.length, 1);
    assert.equal(inner.invokeCalls[0].payload, "sig-intercepted");
  });

  it("intercepts invoke() for feed-like calls", async () => {
    const inner = createFakeTransport({
      invoke: async (_route: string, _payload: unknown, _options?: unknown) => {
        return (async function* () {
          yield 1;
          yield 2;
        })();
      },
    });
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next({ ...ctx, payload: "feed-intercepted" }),
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    const result = await wrapped.invoke("r", "original");

    // Result is an async iterable
    const chunks: unknown[] = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    assert.deepEqual(chunks, [1, 2]);
  });

  it("passes through registerRoutes() and close()", async () => {
    const inner = createFakeTransport();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next(ctx),
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    wrapped.registerRoutes({ foo: "bar" });
    assert.deepEqual(inner.registeredRouter, { foo: "bar" });

    await wrapped.close();
    assert.ok(inner.closeCalled);
  });

  it("middleware can modify/inject meta", async () => {
    const inner = createFakeTransport();
    const mw: ScompMiddleware = {
      name: "auth",
      outbound: async (ctx, next) => {
        return next({ ...ctx, meta: { ...ctx.meta, token: "abc" } });
      },
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    await wrapped.invoke("r", "data");

    assert.equal(inner.invokeCalls.length, 1);
    const opts = inner.invokeCalls[0].options as { meta?: Record<string, unknown> } | undefined;
    assert.equal(opts?.meta?.token, "abc");
  });

  it("middleware can short-circuit (reject calls)", async () => {
    const inner = createFakeTransport();
    const mw: ScompMiddleware = {
      name: "blocker",
      outbound: async () => {
        throw new Error("blocked");
      },
    };

    const wrapped = createMiddlewareTransport(inner, [mw]);
    await assert.rejects(() => wrapped.invoke("r", "data"), { message: "blocked" });
    assert.equal(inner.invokeCalls.length, 0);
  });

  it("multiple middleware compose correctly", async () => {
    const inner = createFakeTransport();
    const order: string[] = [];

    const mw1: ScompMiddleware = {
      name: "first",
      outbound: async (ctx, next) => {
        order.push("first-before");
        const result = await next(ctx);
        order.push("first-after");
        return result;
      },
    };
    const mw2: ScompMiddleware = {
      name: "second",
      outbound: async (ctx, next) => {
        order.push("second-before");
        const result = await next(ctx);
        order.push("second-after");
        return result;
      },
    };

    const wrapped = createMiddlewareTransport(inner, [mw1, mw2]);
    await wrapped.invoke("r", "data");

    assert.deepEqual(order, ["first-before", "second-before", "second-after", "first-after"]);
  });
});

/* ---------- Peer middleware integration ---------- */

describe("Peer middleware integration", () => {
  it("peer with middleware wraps transports for client proxies", () => {
    const t1 = createFakeTransport();
    const { factory, calls } = stubClientFactory();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next(ctx),
    };

    const peer = createScompPeer({
      transports: [t1],
      clientFactory: factory,
      middleware: [mw],
    });

    const token = createContractToken<{ greet(): Promise<string> }>("greeter");
    peer.consumes(token);

    assert.equal(calls.length, 1);
    // The transport passed to factory should be the wrapped one, not the raw one
    assert.notEqual(calls[0].transport, t1);
  });

  it("registerRoutes still goes to raw transport", () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next(ctx),
    };

    const peer = createScompPeer({
      transports: [t1],
      clientFactory: factory,
      middleware: [mw],
      controlPlane: false,
    });

    const router: CompiledRouter = {
      "svc.method": {
        route: "svc.method",
        kind: "request",
        handler: () => undefined,
      },
    };
    peer.provides({
      name: "svc",
      networkIntent: {} as never,
      router,
    });

    assert.ok(t1.registeredRouter);
    assert.ok("svc.method" in t1.registeredRouter);
  });

  it("close() closes raw transports", async () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const mw: ScompMiddleware = {
      name: "test",
      outbound: async (ctx, next) => next(ctx),
    };

    const peer = createScompPeer({
      transports: [t1],
      clientFactory: factory,
      middleware: [mw],
    });

    await peer.close();
    assert.ok(t1.closeCalled);
  });
});
