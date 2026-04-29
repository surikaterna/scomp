import {
  createContractToken,
  createScompService,
  createScompPeer,
  createAuthMiddleware,
  ScompAuthError,
} from "../src/index";
import type { ITransport, ScompClientInvokeOptions } from "../src/index";
import { createInprocessTransport } from "../../transport-inprocess/src/index";

// ---------------------------------------------------------------------------
// Test contract
// ---------------------------------------------------------------------------

interface TestContract {
  echo(input: { msg: string }): Promise<{ msg: string }>;
}

const TestToken = createContractToken<TestContract>("test");

// ---------------------------------------------------------------------------
// Client factory: creates a simple proxy that calls transport.request()
// ---------------------------------------------------------------------------

function simpleClientFactory<C extends object>(transport: ITransport, token: { name: string }): C {
  return new Proxy({} as C, {
    get(_target, method: string) {
      return (payload: unknown) => {
        const route = `${token.name}.${method}`;
        return transport.request(route, payload);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("auth middleware integration through transport", () => {
  it("rejects unauthorized inbound requests through transport", async () => {
    const transport = createInprocessTransport();
    const mw = createAuthMiddleware({ authorize: () => false });

    const peer = createScompPeer({
      transports: [transport],
      clientFactory: simpleClientFactory,
      middleware: [mw],
      controlPlane: false,
    });

    const service = createScompService(TestToken).implement({
      echo: async (input) => ({ msg: input.msg }),
    });
    peer.provides(service);

    const client = peer.consumes(TestToken);

    await expect(client.echo({ msg: "hi" })).rejects.toThrow(/not authorized/i);
  });

  it("allows authorized inbound requests through transport", async () => {
    const transport = createInprocessTransport();
    const principal = { subject: "user-1" };
    const mw = createAuthMiddleware({
      authenticate: () => principal,
      authorize: () => true,
    });

    const peer = createScompPeer({
      transports: [transport],
      clientFactory: simpleClientFactory,
      middleware: [mw],
      controlPlane: false,
    });

    const service = createScompService(TestToken).implement({
      echo: async (input) => ({ msg: input.msg }),
    });
    peer.provides(service);

    const client = peer.consumes(TestToken);
    const result = await client.echo({ msg: "hello" });
    expect(result).toEqual({ msg: "hello" });
  });

  it("outbound injects meta into transport calls", async () => {
    const principal = {
      subject: "user-1",
      tenantId: "tenant-a",
      scopes: ["read"],
      claims: {},
      authType: "jwt",
    };

    // Wrap transport to record request options
    const inner = createInprocessTransport();
    const recorded: Array<{ route: string; options?: ScompClientInvokeOptions }> = [];

    const recordingTransport: ITransport = {
      registerRoutes: (r) => inner.registerRoutes(r),
      close: () => inner.close(),
      async request(route, payload, options?) {
        recorded.push({ route, options });
        return inner.request(route, payload, options);
      },
      async signal(route, payload, options?) {
        recorded.push({ route, options });
        return inner.signal(route, payload, options);
      },
      feed(route, payload, options?) {
        recorded.push({ route, options });
        return inner.feed(route, payload, options);
      },
    };

    const mw = createAuthMiddleware({
      authenticate: () => principal,
      authorize: () => true,
    });

    const peer = createScompPeer({
      transports: [recordingTransport],
      clientFactory: simpleClientFactory,
      middleware: [mw],
      controlPlane: false,
    });

    const service = createScompService(TestToken).implement({
      echo: async (input) => ({ msg: input.msg }),
    });
    peer.provides(service);

    const client = peer.consumes(TestToken);
    await client.echo({ msg: "test" });

    // Find the echo request (not control plane)
    const echoCall = recorded.find((r) => r.route === "test.echo");
    expect(echoCall).toBeDefined();
    expect(echoCall?.options?.meta).toBeDefined();

    const auth = (echoCall?.options?.meta as Record<string, unknown>)?.auth;
    expect(auth).toEqual(expect.objectContaining({ subject: "user-1", tenantId: "tenant-a" }));
  });

  it("outbound blocks unauthorized calls before transport", async () => {
    const transport = createInprocessTransport();
    const mw = createAuthMiddleware({
      authorize: () => false,
    });

    const peer = createScompPeer({
      transports: [transport],
      clientFactory: simpleClientFactory,
      middleware: [mw],
      controlPlane: false,
    });

    const service = createScompService(TestToken).implement({
      echo: async (input) => ({ msg: input.msg }),
    });
    peer.provides(service);

    const client = peer.consumes(TestToken);
    await expect(client.echo({ msg: "hi" })).rejects.toThrow(ScompAuthError);
  });

  it("peer with no middleware works normally", async () => {
    const transport = createInprocessTransport();

    const peer = createScompPeer({
      transports: [transport],
      clientFactory: simpleClientFactory,
      controlPlane: false,
    });

    const service = createScompService(TestToken).implement({
      echo: async (input) => ({ msg: input.msg }),
    });
    peer.provides(service);

    const client = peer.consumes(TestToken);
    const result = await client.echo({ msg: "works" });
    expect(result).toEqual({ msg: "works" });
  });
});
