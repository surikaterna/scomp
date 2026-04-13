import assert from "node:assert/strict";
import { createControlledFeed, createScompFeed } from "../src";

describe("ScompControlledFeed", () => {
  it("builds a controlled feed with request and command methods", () => {
    const feed = createScompFeed<number>();
    let interval = 1000;

    const controlled = createControlledFeed(feed)
      .request("getInterval", () => interval)
      .command("setInterval", (ms: number) => {
        interval = ms;
      })
      .build();

    assert.deepEqual(controlled.controller.kinds, {
      getInterval: "request",
      setInterval: "command",
    });

    assert.equal(controlled.controller.invoke("getInterval", []), 1000);

    controlled.controller.invoke("setInterval", [500]);
    assert.equal(interval, 500);
    assert.equal(controlled.controller.invoke("getInterval", []), 500);
  });

  it("rejects unknown controller method names", () => {
    const feed = createScompFeed<number>();
    const controlled = createControlledFeed(feed)
      .request("ping", () => "pong")
      .build();

    assert.throws(
      () => controlled.controller.invoke("missing", []),
      /Unknown controller method: missing/,
    );
  });

  it("preserves underlying feed data flow", async () => {
    const feed = createScompFeed<number>();
    const controlled = createControlledFeed(feed)
      .command("noop", () => {})
      .build();

    const received: Array<number> = [];

    controlled.next(1).next(2).next(3).complete();

    for await (const value of controlled) {
      received.push(value);
    }

    assert.deepEqual(received, [1, 2, 3]);
  });

  it("supports callback listeners on controlled feed", () => {
    const feed = createScompFeed<string>();
    const controlled = createControlledFeed(feed)
      .request("status", () => "ok")
      .build();

    const received: Array<string> = [];
    let completed = false;

    controlled
      .onNext((value) => received.push(value))
      .onComplete(() => {
        completed = true;
      });

    controlled.next("a").next("b").complete();

    assert.deepEqual(received, ["a", "b"]);
    assert.equal(completed, true);
  });

  it("exposes controller request and command handler maps", () => {
    const feed = createScompFeed<number>();
    const getVal = () => 42;
    const doStuff = (_x: string): void => {};

    const controlled = createControlledFeed(feed)
      .request("getVal", getVal)
      .command("doStuff", doStuff)
      .build();

    assert.equal(typeof controlled.controller.requests.getVal, "function");
    assert.equal(typeof controlled.controller.commands.doStuff, "function");
    assert.equal(controlled.controller.requests.getVal(), 42);
  });
});
