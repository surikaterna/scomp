import { describe, it, expect } from "vitest";
import { createScompResult } from "../src/scomp-result";

describe("ScompResult", () => {
  it("resolves as Promise for request values", async () => {
    const result = createScompResult<{ id: number; name: string }>(
      Promise.resolve({ id: 7, name: "Bob" }),
    );
    const value = await result;
    expect(value).toEqual({ id: 7, name: "Bob" });
  });

  it("resolves as Promise<void> for signals", async () => {
    const result = createScompResult<void>(Promise.resolve(undefined));
    const value = await result;
    expect(value).toBeUndefined();
  });

  it("is async-iterable for feeds", async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const result = createScompResult<number>(Promise.resolve(gen()));

    const values: number[] = [];
    for await (const v of result) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it("propagates errors in then path", async () => {
    const result = createScompResult<unknown>(Promise.reject(new Error("boom")));
    await expect(result).rejects.toThrow("boom");
  });

  it("propagates errors in async iterator path", async () => {
    const result = createScompResult<unknown>(Promise.reject(new Error("boom")));
    const iter = result[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow("boom");
  });

  it("for-await-of uses asyncIterator not then", async () => {
    // This verifies the critical behavior: for-await checks Symbol.asyncIterator first
    async function* gen() {
      yield "a";
      yield "b";
    }
    const result = createScompResult<string>(Promise.resolve(gen()));

    const values: string[] = [];
    for await (const v of result) {
      values.push(v);
    }
    expect(values).toEqual(["a", "b"]);
  });

  it("yields single value for non-iterable results when iterated", async () => {
    const result = createScompResult<number>(Promise.resolve(42));

    const values: number[] = [];
    for await (const v of result) {
      values.push(v);
    }
    expect(values).toEqual([42]);
  });

  it("yields nothing when result is undefined (signal) and iterated", async () => {
    const result = createScompResult<void>(Promise.resolve(undefined));

    const values: unknown[] = [];
    for await (const v of result) {
      values.push(v);
    }
    expect(values).toEqual([]);
  });
});
