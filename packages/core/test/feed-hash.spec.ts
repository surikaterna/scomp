import { vi } from "vitest";
import { createFeedHash, createRuntimeNeutralFeedHasher, type FeedHashOptions } from "../src/feed-hash";

describe("createFeedHash", () => {
  // ── Determinism ──────────────────────────────────────────────────────
  it("returns the same hash for the same route and payload", () => {
    const a = createFeedHash("orders.list", { filter: "active" });
    const b = createFeedHash("orders.list", { filter: "active" });
    expect(a).toBe(b);
  });

  // ── Uniqueness ───────────────────────────────────────────────────────
  it("returns different hashes for different routes", () => {
    const a = createFeedHash("orders.list", { filter: "active" });
    const b = createFeedHash("orders.create", { filter: "active" });
    expect(a).not.toBe(b);
  });

  it("returns different hashes for different payloads", () => {
    const a = createFeedHash("orders.list", { filter: "active" });
    const b = createFeedHash("orders.list", { filter: "archived" });
    expect(a).not.toBe(b);
  });

  // ── Length ───────────────────────────────────────────────────────────
  it("always produces a 32-char hex string", () => {
    const cases = [
      createFeedHash("a", {}),
      createFeedHash("very.long.route.name.here", { x: 1 }),
      createFeedHash("", null),
      createFeedHash("r", undefined),
    ];
    for (const hash of cases) {
      expect(hash).toHaveLength(32);
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  // ── Empty / null / undefined payloads ────────────────────────────────
  it("handles null payload", () => {
    const hash = createFeedHash("route", null);
    expect(hash).toHaveLength(32);
  });

  it("handles undefined payload", () => {
    const hash = createFeedHash("route", undefined);
    expect(hash).toHaveLength(32);
  });

  it("treats null and undefined payload identically (both become {})", () => {
    const a = createFeedHash("route", null);
    const b = createFeedHash("route", undefined);
    expect(a).toBe(b);
  });

  // ── Custom hashKey option ────────────────────────────────────────────
  it("uses hashKey when provided, bypassing hashing", () => {
    const options: FeedHashOptions = {
      hashKey: (payload) => `custom-${String(payload)}`,
    };
    const result = createFeedHash("route", "data", options);
    expect(result).toBe("custom-data");
  });

  it("hashKey receives the original payload", () => {
    const spy = vi.fn(() => "fixed-key");
    const payload = { complex: true };
    createFeedHash("route", payload, { hashKey: spy });
    expect(spy).toHaveBeenCalledWith(payload);
  });

  // ── Custom stringify option ──────────────────────────────────────────
  it("uses custom stringify when provided", () => {
    const customStringify = vi.fn(() => "custom-serialized");
    const hash = createFeedHash("route", { a: 1 }, { stringify: customStringify });
    expect(customStringify).toHaveBeenCalledWith({ a: 1 });
    expect(hash).toHaveLength(32);
  });

  it("custom stringify changes the resulting hash", () => {
    const defaultHash = createFeedHash("route", { a: 1 });
    const customHash = createFeedHash(
      "route",
      { a: 1 },
      {
        stringify: () => "always-the-same",
      },
    );
    expect(defaultHash).not.toBe(customHash);
  });

  // ── Custom hash option ───────────────────────────────────────────────
  it("uses custom hash function when provided", () => {
    const customHash = vi.fn(() => "abcdef1234567890abcdef1234567890");
    const result = createFeedHash("route", {}, { hash: customHash });
    expect(customHash).toHaveBeenCalled();
    expect(result).toBe("abcdef1234567890abcdef1234567890");
  });

  it("normalizes short custom hash output to 32 chars", () => {
    const result = createFeedHash(
      "route",
      {},
      {
        hash: () => "abc",
      },
    );
    expect(result).toHaveLength(32);
    expect(result).toBe(`abc${"0".repeat(29)}`);
  });

  it("truncates long custom hash output to 32 chars", () => {
    const long = "a".repeat(64);
    const result = createFeedHash("route", {}, { hash: () => long });
    expect(result).toHaveLength(32);
    expect(result).toBe("a".repeat(32));
  });

  // ── Edge cases ───────────────────────────────────────────────────────
  it("handles empty route", () => {
    const hash = createFeedHash("", { data: true });
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles very long payloads", () => {
    const longPayload = { data: "x".repeat(100_000) };
    const hash = createFeedHash("route", longPayload);
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles special characters in route and payload", () => {
    const hash = createFeedHash("rte/with spaces & émojis 🎉", {
      key: "value with\nnewlines\tand\ttabs",
    });
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("createRuntimeNeutralFeedHasher", () => {
  it("returns a function", () => {
    const hasher = createRuntimeNeutralFeedHasher();
    expect(typeof hasher).toBe("function");
  });

  it("produces consistent 32-char hex strings", () => {
    const hasher = createRuntimeNeutralFeedHasher();
    const a = hasher("test-input");
    const b = hasher("test-input");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces different hashes for different inputs", () => {
    const hasher = createRuntimeNeutralFeedHasher();
    const a = hasher("input-one");
    const b = hasher("input-two");
    expect(a).not.toBe(b);
  });

  it("each call creates an independent hasher with same behavior", () => {
    const hasher1 = createRuntimeNeutralFeedHasher();
    const hasher2 = createRuntimeNeutralFeedHasher();
    expect(hasher1("shared-input")).toBe(hasher2("shared-input"));
  });

  it("handles empty string input", () => {
    const hasher = createRuntimeNeutralFeedHasher();
    const result = hasher("");
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles very long input", () => {
    const hasher = createRuntimeNeutralFeedHasher();
    const result = hasher("x".repeat(100_000));
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});
