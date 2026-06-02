import { describe, it, expect } from "vitest";
import { createContractToken, createScompService } from "@scompr/core";
import { createInprocessTransport } from "../src/index";

const token = createContractToken<{
  echo(x: string): Promise<string>;
  ping(): void;
  numbers(): AsyncIterable<number>;
}>("test");

function createTestService() {
  return createScompService(token).implement({
    requests: {
      echo(x: string) {
        return Promise.resolve(x);
      },
    },
    signals: {
      ping() {
        // noop
      },
    },
    feeds: {
      numbers() {
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (i >= 3) return { done: true as const, value: undefined };
                return { done: false as const, value: ++i };
              },
            };
          },
        };
      },
    },
  });
}

describe("invoke()", () => {
  it("handles request routes", async () => {
    const transport = createInprocessTransport();
    const service = createTestService();
    transport.registerRoutes(service.router);

    const result = await transport.invoke!("test.echo", "hello");
    expect(result).toBe("hello");
  });

  it("handles signal routes (returns undefined)", async () => {
    const transport = createInprocessTransport();
    const service = createTestService();
    transport.registerRoutes(service.router);

    const result = await transport.invoke!("test.ping", null);
    expect(result).toBeUndefined();
  });

  it("handles feed routes (returns AsyncIterable)", async () => {
    const transport = createInprocessTransport();
    const service = createTestService();
    transport.registerRoutes(service.router);

    const result = await transport.invoke!("test.numbers", null);
    expect(result).toBeDefined();
    expect(Symbol.asyncIterator in (result as object)).toBe(true);

    const values: number[] = [];
    for await (const v of result as AsyncIterable<number>) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });
});
