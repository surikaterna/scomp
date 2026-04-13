import assert from "node:assert/strict";
import {
  createScompClient,
  createScompFeed,
  createScompService,
  createScompServiceFromDescriptor,
  type ScompTransport,
} from "../src";

describe("ScompServiceBuilder and createScompClient", () => {
  it("routes request/feed/command methods to the matching transport operation", async () => {
    const feed = createScompFeed<number>();

    const service = createScompService()
      .request("sum", async (left: number, right: number) => left + right)
      .feed("watchNumbers", () => feed)
      .command("log", (_message: string): void => {})
      .build();

    const calls: Array<{ method: string; args: Array<unknown> }> = [];

    const transport: ScompTransport = {
      request: async (methodName, args) => {
        calls.push({ method: `request:${methodName}`, args: [...args] });
        return 5;
      },
      observe: (methodName, args) => {
        calls.push({ method: `observe:${methodName}`, args: [...args] });
        return feed;
      },
      fireAndForget: (methodName, args) => {
        calls.push({ method: `command:${methodName}`, args: [...args] });
      },
    };

    const client = createScompClient(service, transport);

    const sumResult = await client.sum(2, 3);
    assert.equal(sumResult, 5);

    const stream = client.watchNumbers();
    stream.next(11).complete();

    const received: Array<number> = [];
    for await (const value of stream) {
      received.push(value);
    }

    const fireAndForgetResult = client.log("hello");

    assert.equal(fireAndForgetResult, undefined);
    assert.deepEqual(received, [11]);
    assert.deepEqual(calls, [
      { method: "request:sum", args: [2, 3] },
      { method: "observe:watchNumbers", args: [] },
      { method: "command:log", args: ["hello"] },
    ]);
  });

  it("supports descriptor-based service creation", async () => {
    const service = createScompServiceFromDescriptor({
      requests: {
        ping: () => "pong",
      },
      commands: {
        log: (_message: string): void => {},
      },
    });

    const transport: ScompTransport = {
      request: async () => "pong",
      observe: () => createScompFeed(),
      fireAndForget: () => {},
    };

    const client = createScompClient(service, transport);
    assert.equal(await client.ping(), "pong");
    assert.equal(client.log("ok"), undefined);
  });

  it("exposes method kinds and supports service invocation", () => {
    const feed = createScompFeed<number>();
    const service = createScompService()
      .request("sum", (left: number, right: number) => left + right)
      .feed("watch", () => feed)
      .command("log", (_value: string): void => {})
      .build();

    assert.deepEqual(service.kinds, {
      sum: "request",
      watch: "feed",
      log: "command",
    });

    assert.equal(service.invoke("sum", [4, 7]), 11);

    assert.throws(
      () => service.invoke("missing", []),
      /Unknown service method: missing/,
    );
  });

  it("rejects duplicate method names across descriptor sections", () => {
    assert.throws(
      () =>
        createScompServiceFromDescriptor({
          requests: {
            duplicate: () => "ok",
          },
          feeds: {
            duplicate: () => createScompFeed<string>(),
          },
        }),
      /Each method name must be unique/,
    );
  });
});
