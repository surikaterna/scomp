import assert from "node:assert/strict";
import {
  createControlledFeed,
  SCOMP_SCOPE,
  type ControlledAsyncIterable,
} from "../src";

async function* generate<T>(...values: T[]): AsyncIterable<T> {
  for (const v of values) yield v;
}

describe("createControlledFeed", () => {
  it("returns an object that is async-iterable", async () => {
    const feed = createControlledFeed(generate(1, 2, 3), {});
    const values: number[] = [];
    for await (const v of feed) {
      values.push(v);
    }
    assert.deepEqual(values, [1, 2, 3]);
  });

  it("exposes the provided methods via .controller", () => {
    const methods = {
      pause: () => Promise.resolve(),
      seek: (offset: number) => Promise.resolve(offset * 2),
    };
    const feed = createControlledFeed(generate<string>(), methods);

    assert.strictEqual(feed.controller, methods);
    assert.equal(typeof feed.controller.pause, "function");
    assert.equal(typeof feed.controller.seek, "function");
  });

  it("allows calling controller methods that return a value", async () => {
    const methods = {
      seek: (offset: number) => Promise.resolve(offset * 2),
    };
    const feed = createControlledFeed(generate<number>(), methods);

    const result = await feed.controller.seek(5);
    assert.equal(result, 10);
  });

  it("allows calling controller methods that return void", async () => {
    let paused = false;
    const methods = {
      pause: (): Promise<void> => {
        paused = true;
        return Promise.resolve();
      },
    };
    const feed = createControlledFeed(generate<number>(), methods);

    await feed.controller.pause();
    assert.equal(paused, true);
  });

  it("throws on controller method names with __scomp. prefix", () => {
    assert.throws(
      () =>
        createControlledFeed(generate<number>(), {
          "__scomp.internal": () => {},
        }),
      {
        message:
          'Controller method "__scomp.internal" uses reserved __scomp. prefix.',
      },
    );
  });

  it("throws on multiple __scomp. prefixed keys (first match)", () => {
    assert.throws(
      () =>
        createControlledFeed(generate<number>(), {
          legit: () => {},
          "__scomp.foo": () => {},
          "__scomp.bar": () => {},
        }),
      /uses reserved __scomp\. prefix/,
    );
  });

  it("iterates values from the original iterable", async () => {
    const source = generate("a", "b", "c");
    const feed = createControlledFeed(source, { noop: () => {} });
    const values: string[] = [];

    for await (const v of feed) {
      values.push(v);
    }

    assert.deepEqual(values, ["a", "b", "c"]);
  });

  it("works with an empty iterable", async () => {
    const feed = createControlledFeed(generate<number>(), {});
    const values: number[] = [];

    for await (const v of feed) {
      values.push(v);
    }

    assert.deepEqual(values, []);
  });

  it("accepts controller methods with mixed return types", async () => {
    const methods = {
      signal: (): Promise<void> => Promise.resolve(),
      request: (x: number): Promise<number> => Promise.resolve(x + 1),
      syncMethod: () => 42,
    };
    const feed: ControlledAsyncIterable<string, typeof methods> =
      createControlledFeed(generate("x"), methods);

    await feed.controller.signal();
    const reqResult = await feed.controller.request(10);
    const syncResult = feed.controller.syncMethod();

    assert.equal(reqResult, 11);
    assert.equal(syncResult, 42);
  });

  it("defaults to exclusive scope when no options given", () => {
    const feed = createControlledFeed(generate(1), {});
    assert.equal(feed[SCOMP_SCOPE], "exclusive");
  });

  it("sets scope to 'fanout' when scope option is fanout", () => {
    const feed = createControlledFeed(generate(1), {}, { scope: "fanout" });
    assert.equal(feed[SCOMP_SCOPE], "fanout");
  });

  it("sets scope to 'exclusive' when scope option is explicit", () => {
    const feed = createControlledFeed(generate(1), {}, { scope: "exclusive" });
    assert.equal(feed[SCOMP_SCOPE], "exclusive");
  });
});
