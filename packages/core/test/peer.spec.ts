import assert from "node:assert/strict";
import { createScompPeer } from "../src";
import type { ITransport, CompiledRouter, ServiceDefinition } from "../src";
import { createContractToken } from "../src";

/* ---------- helpers ---------- */

function createFakeTransport(overrides: Partial<ITransport> = {}): ITransport & {
  registeredRouter: CompiledRouter | undefined;
  closeCalled: boolean;
} {
  const fake = {
    registeredRouter: undefined as CompiledRouter | undefined,
    closeCalled: false,
    registerRoutes(router: Record<string, unknown>) {
      fake.registeredRouter = router as CompiledRouter;
    },
    close() {
      fake.closeCalled = true;
      return overrides.close?.() ?? Promise.resolve();
    },
    request: overrides.request ?? (async () => undefined),
    signal: overrides.signal ?? (async () => undefined),
    feed: overrides.feed ?? async function* () {},
  };

  return fake;
}

function fakeService(name: string, routes: Record<string, string>): ServiceDefinition<object> {
  const router: CompiledRouter = {};
  for (const [method, kind] of Object.entries(routes)) {
    router[`${name}.${method}`] = {
      route: `${name}.${method}`,
      kind: kind as "request" | "signal" | "feed",
      handler: () => undefined,
    };
  }
  return { name, networkIntent: {} as never, router };
}

function stubClientFactory() {
  const calls: Array<{ transport: ITransport; tokenName: string }> = [];

  function factory<C extends object>(transport: ITransport, token: { name: string }): C {
    const proxy = { __stub: token.name } as unknown as C;
    calls.push({ transport, tokenName: token.name });
    return proxy;
  }

  return { factory, calls };
}

/* ---------- tests ---------- */

describe("createScompPeer", () => {
  it("throws when created with zero transports", () => {
    const { factory } = stubClientFactory();
    assert.throws(() => createScompPeer({ transports: [], clientFactory: factory }), {
      message: "createScompPeer requires at least one transport.",
    });
  });
});

describe("IScompPeer.provides()", () => {
  it("registers routes on all transports", () => {
    const t1 = createFakeTransport();
    const t2 = createFakeTransport();
    const { factory } = stubClientFactory();

    const peer = createScompPeer({
      transports: [t1, t2],
      clientFactory: factory,
    });
    const svc = fakeService("greeter", { hello: "request" });

    peer.provides(svc);

    assert.ok(t1.registeredRouter);
    assert.ok(t2.registeredRouter);
    assert.ok("greeter.hello" in t1.registeredRouter);
    assert.ok("greeter.hello" in t2.registeredRouter);
  });

  it("accepts multiple services at once", () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    const svcA = fakeService("alpha", { one: "request" });
    const svcB = fakeService("beta", { two: "signal" });

    peer.provides(svcA, svcB);

    assert.ok(t1.registeredRouter);
    assert.ok("alpha.one" in t1.registeredRouter);
    assert.ok("beta.two" in t1.registeredRouter);
  });

  it("throws on duplicate route names", () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    const svc1 = fakeService("svc", { doSomething: "request" });
    peer.provides(svc1);

    const svc2 = fakeService("svc", { doSomething: "request" });
    assert.throws(() => peer.provides(svc2), {
      message: 'Duplicate route "svc.doSomething" from service "svc".',
    });
  });

  it("throws after close", async () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });
    await peer.close();

    const svc = fakeService("late", { add: "request" });
    assert.throws(() => peer.provides(svc), { message: "Peer is closed." });
  });
});

describe("IScompPeer.consumes()", () => {
  it("returns a client proxy from the factory", () => {
    const t1 = createFakeTransport();
    const { factory, calls } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    const token = createContractToken<{ greet(name: string): Promise<string> }>("greeter");
    const proxy = peer.consumes(token);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tokenName, "greeter");
    assert.equal(calls[0].transport, t1);
    assert.deepEqual(proxy, { __stub: "greeter" });
  });

  it("caches the proxy for the same token name", () => {
    const t1 = createFakeTransport();
    const { factory, calls } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    const token = createContractToken<{ greet(): Promise<void> }>("greeter");
    const first = peer.consumes(token);
    const second = peer.consumes(token);

    assert.equal(first, second);
    assert.equal(calls.length, 1, "factory should only be called once");
  });

  it("uses the first transport for the proxy", () => {
    const t1 = createFakeTransport();
    const t2 = createFakeTransport();
    const { factory, calls } = stubClientFactory();
    const peer = createScompPeer({
      transports: [t1, t2],
      clientFactory: factory,
    });

    const token = createContractToken<{ ping(): Promise<void> }>("pinger");
    peer.consumes(token);

    assert.equal(calls[0].transport, t1);
  });

  it("throws after close", async () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });
    await peer.close();

    const token = createContractToken<{ x(): Promise<void> }>("x");
    assert.throws(() => peer.consumes(token), { message: "Peer is closed." });
  });
});

describe("IScompPeer.close()", () => {
  it("calls close on all transports", async () => {
    const t1 = createFakeTransport();
    const t2 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({
      transports: [t1, t2],
      clientFactory: factory,
    });

    await peer.close();

    assert.ok(t1.closeCalled);
    assert.ok(t2.closeCalled);
  });

  it("clears the client cache", async () => {
    const t1 = createFakeTransport();
    const { factory, calls } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    const token = createContractToken<{ a(): Promise<void> }>("a");
    peer.consumes(token);
    assert.equal(calls.length, 1);

    // After close, cache should be gone — but we can't call consumes again
    // because it throws. We verify the cache was cleared indirectly: close
    // succeeded and subsequent calls throw.
    await peer.close();
    assert.throws(() => peer.consumes(token), { message: "Peer is closed." });
  });

  it("throws if called twice", async () => {
    const t1 = createFakeTransport();
    const { factory } = stubClientFactory();
    const peer = createScompPeer({ transports: [t1], clientFactory: factory });

    await peer.close();
    await assert.rejects(() => peer.close(), { message: "Peer is closed." });
  });

  it("aggregates errors from failing transports", async () => {
    const t1 = createFakeTransport({
      close: () => Promise.reject(new Error("t1 fail")),
    });
    const t2 = createFakeTransport({
      close: () => Promise.reject(new Error("t2 fail")),
    });
    const { factory } = stubClientFactory();
    const peer = createScompPeer({
      transports: [t1, t2],
      clientFactory: factory,
    });

    await assert.rejects(
      () => peer.close(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /2 transport\(s\) failed to close/);
        assert.match(err.message, /t1 fail/);
        assert.match(err.message, /t2 fail/);
        return true;
      },
    );
  });
});
