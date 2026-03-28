import assert from "node:assert/strict";
import {
  createScompClient,
  createScompFeed,
  createLegacyScompService,
} from "@scomp/core";
import { createInprocessTransport } from "../src";

describe("createInprocessTransport", () => {
  it("supports request/response, feed streaming and fire-and-forget commands", async () => {
    const commands: Array<string> = [];

    const service = createLegacyScompService()
      .request("multiply", async (left: number, right: number) => left * right)
      .feed("countTo", async function* (limit: number) {
        for (let value = 1; value <= limit; value += 1) {
          yield value;
        }
      })
      .command("log", (message: string): void => {
        commands.push(message);
      })
      .build();

    const transport = createInprocessTransport(service);
    const client = createScompClient(service, transport);

    const requestResult = await client.multiply(4, 5);
    assert.equal(requestResult, 20);

    const feedResult: Array<number> = [];
    for await (const value of client.countTo(3)) {
      feedResult.push(value);
    }

    const commandResult = client.log("fire-and-forget");

    assert.equal(commandResult, undefined);
    assert.deepEqual(feedResult, [1, 2, 3]);
    assert.deepEqual(commands, ["fire-and-forget"]);
  });

  it("keeps native ScompFeed responses as feed responses", async () => {
    const service = createLegacyScompService()
      .feed("watch", () => {
        const feed = createScompFeed<number>();
        queueMicrotask(() => {
          feed.next(7).next(8).complete();
        });
        return feed;
      })
      .build();

    const transport = createInprocessTransport(service);
    const client = createScompClient(service, transport);

    const values: Array<number> = [];
    for await (const value of client.watch()) {
      values.push(value);
    }

    assert.deepEqual(values, [7, 8]);
  });

  it("rejects request/response calls for feed methods", async () => {
    const service = createLegacyScompService()
      .feed("countTo", async function* (limit: number) {
        for (let value = 1; value <= limit; value += 1) {
          yield value;
        }
      })
      .build();

    const transport = createInprocessTransport(service);

    await assert.rejects(
      () => transport.request("countTo", [3]),
      /configured as a feed and cannot be used as request\/response/,
    );
  });

  it("rejects observe calls for non-feed values", () => {
    const service = createLegacyScompService()
      .request("multiply", (left: number, right: number) => left * right)
      .build();

    const transport = createInprocessTransport(service);

    assert.throws(
      () => transport.observe("multiply", [3, 4]),
      /did not return a feed-compatible value/,
    );
  });

  it("routes fire-and-forget sync and async failures to onFireAndForgetError", async () => {
    const observedErrors: Array<{
      error: unknown;
      methodName: string;
      args: ReadonlyArray<unknown>;
    }> = [];

    const service = createLegacyScompService()
      .command("failSync", () => {
        throw new Error("sync failure");
      })
      .command("failAsync", async (input: string) => {
        throw new Error(`async failure: ${input}`);
      })
      .build();

    const transport = createInprocessTransport(service, {
      onFireAndForgetError(error, methodName, args) {
        observedErrors.push({ error, methodName, args });
      },
    });
    const client = createScompClient(service, transport);

    assert.doesNotThrow(() => {
      client.failSync();
    });

    client.failAsync("payload");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(observedErrors.length, 2);
    assert.equal(observedErrors[0]?.methodName, "failSync");
    assert.deepEqual(observedErrors[0]?.args, []);
    assert.equal((observedErrors[0]?.error as Error).message, "sync failure");
    assert.equal(observedErrors[1]?.methodName, "failAsync");
    assert.deepEqual(observedErrors[1]?.args, ["payload"]);
    assert.equal(
      (observedErrors[1]?.error as Error).message,
      "async failure: payload",
    );
  });
});
