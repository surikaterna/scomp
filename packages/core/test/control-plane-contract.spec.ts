import assert from "node:assert/strict";
import { ScompControlPlane, createScompPeer } from "../src";
import type { ITransport, CompiledRouter } from "../src";

function createFakeTransport(
  overrides: Partial<ITransport> = {},
): ITransport & {
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

function stubClientFactory() {
  const calls: Array<{ transport: ITransport; tokenName: string }> = [];

  function factory<C extends object>(
    transport: ITransport,
    token: { name: string },
  ): C {
    const proxy = { __stub: token.name } as unknown as C;
    calls.push({ transport, tokenName: token.name });
    return proxy;
  }

  return { factory, calls };
}

describe("ScompControlPlane token", () => {
  it("has the reserved __scomp name", () => {
    assert.equal(ScompControlPlane.name, "__scomp");
  });
});

describe("peer auto-provides control plane", () => {
  it("registers control-plane routes by default", () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
    });

    assert.ok(transport.registeredRouter, "router should be registered");
    assert.ok(
      "__scomp.discover" in transport.registeredRouter,
      "discover route should be present",
    );
    assert.ok(
      "__scomp.resolve" in transport.registeredRouter,
      "resolve route should be present",
    );
    assert.ok(
      "__scomp.health" in transport.registeredRouter,
      "health route should be present",
    );
  });

  it("registers control-plane routes with controlPlane: true", () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
      controlPlane: true,
    });

    assert.ok(transport.registeredRouter);
    assert.ok("__scomp.discover" in transport.registeredRouter);
  });

  it("registers control-plane routes with a custom nodeId", () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
      controlPlane: { nodeId: "custom-node" },
    });

    assert.ok(transport.registeredRouter);
    assert.ok("__scomp.discover" in transport.registeredRouter);
    assert.ok("__scomp.resolve" in transport.registeredRouter);
    assert.ok("__scomp.health" in transport.registeredRouter);
  });

  it("does NOT register control-plane routes when controlPlane is false", () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
      controlPlane: false,
    });

    // When controlPlane is false, no provides() is called, so no routes are registered.
    assert.equal(transport.registeredRouter, undefined);
  });

  it("control-plane routes have kind 'request'", () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
    });

    const router = transport.registeredRouter!;
    assert.equal(router["__scomp.discover"].kind, "request");
    assert.equal(router["__scomp.resolve"].kind, "request");
    assert.equal(router["__scomp.health"].kind, "request");
  });

  it("discover handler returns service inventory", async () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    const peer = createScompPeer({
      transports: [transport],
      clientFactory: factory,
      controlPlane: { nodeId: "test-node" },
    });

    // Add a user service to see it in discover results.
    peer.provides({
      name: "users",
      networkIntent: {} as never,
      router: {
        "users.getUser": {
          route: "users.getUser",
          kind: "request" as const,
          handler: async () => ({ id: 1 }),
        },
      },
    });

    const router = transport.registeredRouter!;
    const discoverRoute = router["__scomp.discover"];
    const result = (await discoverRoute.handler({ includeRoutes: true })) as {
      services: Array<{ name: string; routes?: string[] }>;
      node: { id: string };
    };

    assert.equal(result.node.id, "test-node");
    const usersService = result.services.find((s) => s.name === "users");
    assert.ok(usersService, "users service should appear in discover results");
    assert.ok(usersService.routes?.includes("users.getUser"));
  });

  it("health handler returns status with configured nodeId", async () => {
    const transport = createFakeTransport();
    const { factory } = stubClientFactory();

    createScompPeer({
      transports: [transport],
      clientFactory: factory,
      controlPlane: { nodeId: "health-node" },
    });

    const router = transport.registeredRouter!;
    const healthRoute = router["__scomp.health"];
    const result = (await healthRoute.handler({})) as {
      status: string;
      node: { id: string };
    };

    assert.equal(result.node.id, "health-node");
    assert.equal(result.status, "ok");
  });
});
