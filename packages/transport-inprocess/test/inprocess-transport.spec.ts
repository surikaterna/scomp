import assert from "node:assert/strict";
import { createContractToken, createScompService, createScompFeed, type CompiledRouter } from "@scompr/core";
import { createInprocessTransport } from "../src";

/* ---------- contract definitions ---------- */

interface MathContract {
  multiply(input: { left: number; right: number }): Promise<number>;
}

interface StreamContract {
  countTo(input: { limit: number }): AsyncIterable<number>;
}

interface CommandContract {
  log(input: { message: string }): Promise<void>;
}

interface FailingContract {
  failSync(input: Record<string, never>): Promise<void>;
  failAsync(input: { value: string }): Promise<void>;
}

/* ---------- helpers ---------- */

function buildRouter(...services: Array<{ router: CompiledRouter }>): CompiledRouter {
  const combined: CompiledRouter = {};
  for (const service of services) {
    Object.assign(combined, service.router);
  }
  return combined;
}

/* ---------- tests ---------- */

describe("createInprocessTransport", () => {
  it("handles request/response via invoke()", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const service = createScompService(mathToken).implement({
      multiply: async (input) => input.left * input.right,
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("math.multiply", {
      left: 4,
      right: 5,
    });
    assert.equal(result, 20);
  });

  it("handles async generator feeds via invoke()", async () => {
    const streamToken = createContractToken<StreamContract>("stream");
    const service = createScompService(streamToken).implement({
      feeds: {
        countTo: async function* (input) {
          for (let i = 1; i <= input.limit; i += 1) {
            yield i;
          }
        },
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("stream.countTo", { limit: 3 });
    const values: Array<number> = [];
    for await (const value of result as AsyncIterable<number>) {
      values.push(value);
    }

    assert.deepEqual(values, [1, 2, 3]);
  });

  it("handles ScompFeed instances as feed responses", async () => {
    const watchToken = createContractToken<{
      watch(input: Record<string, never>): AsyncIterable<number>;
    }>("watcher");

    const service = createScompService(watchToken).implement({
      feeds: {
        watch: () => {
          const feed = createScompFeed<number>();
          queueMicrotask(() => {
            feed.next(7).next(8).complete();
          });
          return feed;
        },
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("watcher.watch", {});
    const values: Array<number> = [];
    for await (const value of result as AsyncIterable<number>) {
      values.push(value);
    }

    assert.deepEqual(values, [7, 8]);
  });

  it("handles signal (fire-and-forget) via invoke()", async () => {
    const commands: Array<string> = [];
    const cmdToken = createContractToken<CommandContract>("cmd");
    const service = createScompService(cmdToken).implement({
      signals: {
        log: async (input) => {
          commands.push(input.message);
        },
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("cmd.log", { message: "fire-and-forget" });
    assert.equal(result, undefined);

    assert.deepEqual(commands, ["fire-and-forget"]);
  });

  it("invoke returns AsyncIterable for feed routes", async () => {
    const streamToken = createContractToken<StreamContract>("stream");
    const service = createScompService(streamToken).implement({
      feeds: {
        countTo: async function* (input) {
          for (let i = 1; i <= input.limit; i += 1) {
            yield i;
          }
        },
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("stream.countTo", { limit: 3 });
    assert.ok(result != null && typeof result === "object" && Symbol.asyncIterator in (result as object));
  });

  it("invoke throws for non-feed handlers that don't return AsyncIterable", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const service = createScompService(mathToken).implement({
      multiply: async (input) => input.left * input.right,
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    // request kind just returns the value
    const result = await transport.invoke("math.multiply", { left: 3, right: 4 });
    assert.equal(result, 12);
  });

  it("routes sync and async signal failures to onSignalError", async () => {
    const observedErrors: Array<{ error: unknown; route: string }> = [];

    const failToken = createContractToken<FailingContract>("fail");
    const service = createScompService(failToken).implement({
      signals: {
        failSync: () => {
          throw new Error("sync failure");
        },
        failAsync: async (input) => {
          throw new Error(`async failure: ${input.value}`);
        },
      },
    });

    const transport = createInprocessTransport({
      onSignalError(error, route) {
        observedErrors.push({ error, route });
      },
    });
    transport.registerRoutes(service.router);

    // Sync signal failure should not throw (caught by onSignalError)
    await transport.invoke("fail.failSync", {});

    await transport.invoke("fail.failAsync", { value: "payload" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(observedErrors.length, 2);
    assert.equal(observedErrors[0]?.route, "fail.failSync");
    assert.equal((observedErrors[0]?.error as Error).message, "sync failure");
    assert.equal(observedErrors[1]?.route, "fail.failAsync");
    assert.equal((observedErrors[1]?.error as Error).message, "async failure: payload");
  });

  it("throws when calling invoke before registerRoutes", async () => {
    const transport = createInprocessTransport();

    await assert.rejects(() => transport.invoke("math.multiply", { left: 1, right: 2 }), /No routes registered/);
  });

  it("throws for unknown routes", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const service = createScompService(mathToken).implement({
      multiply: async (input) => input.left * input.right,
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    await assert.rejects(() => transport.invoke("math.nonexistent", {}), /Route "math.nonexistent" not found/);
  });

  it("supports multiple services via combined router", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const mathService = createScompService(mathToken).implement({
      multiply: async (input) => input.left * input.right,
    });

    const streamToken = createContractToken<StreamContract>("stream");
    const streamService = createScompService(streamToken).implement({
      feeds: {
        countTo: async function* (input) {
          for (let i = 1; i <= input.limit; i += 1) {
            yield i;
          }
        },
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(buildRouter(mathService, streamService));

    const product = await transport.invoke("math.multiply", {
      left: 3,
      right: 7,
    });
    assert.equal(product, 21);

    const result = await transport.invoke("stream.countTo", { limit: 2 });
    const values: Array<number> = [];
    for await (const v of result as AsyncIterable<number>) {
      values.push(v);
    }
    assert.deepEqual(values, [1, 2]);
  });

  it("clears routes on close()", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const service = createScompService(mathToken).implement({
      multiply: async (input) => input.left * input.right,
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    await transport.close();

    await assert.rejects(() => transport.invoke("math.multiply", { left: 1, right: 2 }), /No routes registered/);
  });

  it("applies parser when present on a route", async () => {
    const mathToken = createContractToken<MathContract>("math");
    const service = createScompService(mathToken).implement({
      multiply: {
        parser: (payload) => {
          const raw = payload as { left: string; right: string };
          return { left: Number(raw.left), right: Number(raw.right) };
        },
        handler: async (input) => input.left * input.right,
      },
    });

    const transport = createInprocessTransport();
    transport.registerRoutes(service.router);

    const result = await transport.invoke("math.multiply", {
      left: "6",
      right: "7",
    });
    assert.equal(result, 42);
  });
});
