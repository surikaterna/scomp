import assert from "node:assert/strict";
import { safeJsonParse, type JsonParseResult } from "../src/parsing";

describe("safeJsonParse", () => {
  it("returns ok result for valid JSON", () => {
    const result = safeJsonParse('{"key":"value"}');
    assert.equal(result.ok, true);
    assert.deepEqual((result as Extract<JsonParseResult, { ok: true }>).value, {
      key: "value",
    });
  });

  it("returns ok result for JSON primitives", () => {
    assert.deepEqual(safeJsonParse("42"), { ok: true, value: 42 });
    assert.deepEqual(safeJsonParse('"hello"'), { ok: true, value: "hello" });
    assert.deepEqual(safeJsonParse("null"), { ok: true, value: null });
    assert.deepEqual(safeJsonParse("true"), { ok: true, value: true });
  });

  it("returns ok result for JSON arrays", () => {
    const result = safeJsonParse("[1,2,3]");
    assert.equal(result.ok, true);
    assert.deepEqual(
      (result as Extract<JsonParseResult, { ok: true }>).value,
      [1, 2, 3],
    );
  });

  it("returns error result for invalid JSON", () => {
    const result = safeJsonParse("not json");
    assert.equal(result.ok, false);
    const err = result as Extract<JsonParseResult, { ok: false }>;
    assert.equal(typeof err.error, "string");
    assert.ok(err.error.length > 0);
    assert.equal(err.raw, "not json");
  });

  it("returns error result for empty string", () => {
    const result = safeJsonParse("");
    assert.equal(result.ok, false);
    const err = result as Extract<JsonParseResult, { ok: false }>;
    assert.equal(err.raw, "");
  });

  it("truncates raw field to 200 characters on failure", () => {
    const longText = "x".repeat(300);
    const result = safeJsonParse(longText);
    assert.equal(result.ok, false);
    const err = result as Extract<JsonParseResult, { ok: false }>;
    assert.equal(err.raw.length, 201); // 200 chars + ellipsis character
    assert.ok(err.raw.endsWith("…"));
  });

  it("preserves raw field when input is 200 chars or fewer", () => {
    const shortText = "y".repeat(200);
    const result = safeJsonParse(shortText);
    assert.equal(result.ok, false);
    const err = result as Extract<JsonParseResult, { ok: false }>;
    assert.equal(err.raw, shortText);
    assert.equal(err.raw.length, 200);
  });
});
