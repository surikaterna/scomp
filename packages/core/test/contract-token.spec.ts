import assert from "node:assert/strict";
import { createContractToken, type ContractToken } from "../src";

describe("createContractToken", () => {
  it("returns an object with the correct name", () => {
    const token = createContractToken<{ greet(): string }>("greeter");
    assert.equal(token.name, "greeter");
  });

  it("has __contract present but undefined at runtime (phantom)", () => {
    const token = createContractToken<{ foo(): void }>("phantom-test");
    assert.ok("__contract" in token);
    assert.equal(token.__contract, undefined);
  });

  it("throws on empty string name", () => {
    assert.throws(() => createContractToken(""), {
      message: "Contract token name must be a non-empty string.",
    });
  });

  it("throws on non-string input", () => {
    assert.throws(() => createContractToken(123 as unknown as string), {
      message: "Contract token name must be a non-empty string.",
    });
    assert.throws(() => createContractToken(null as unknown as string), {
      message: "Contract token name must be a non-empty string.",
    });
    assert.throws(() => createContractToken(undefined as unknown as string), {
      message: "Contract token name must be a non-empty string.",
    });
  });
});
