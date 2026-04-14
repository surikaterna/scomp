import assert from "node:assert/strict";
import { SCOMP_FRAMEWORK_PREFIX, ScompFrameworkMethods } from "../src";

describe("framework-methods", () => {
  describe("SCOMP_FRAMEWORK_PREFIX", () => {
    it("equals the __scomp. prefix", () => {
      assert.equal(SCOMP_FRAMEWORK_PREFIX, "__scomp.");
    });
  });

  describe("ScompFrameworkMethods", () => {
    it("has UNSUBSCRIBE with correct value", () => {
      assert.equal(ScompFrameworkMethods.UNSUBSCRIBE, "__scomp.unsubscribe");
    });

    it("has PAUSE with correct value", () => {
      assert.equal(ScompFrameworkMethods.PAUSE, "__scomp.pause");
    });

    it("has RESUME with correct value", () => {
      assert.equal(ScompFrameworkMethods.RESUME, "__scomp.resume");
    });

    it("has STATS with correct value", () => {
      assert.equal(ScompFrameworkMethods.STATS, "__scomp.stats");
    });

    it("all values start with the framework prefix", () => {
      for (const value of Object.values(ScompFrameworkMethods)) {
        assert.ok(
          value.startsWith(SCOMP_FRAMEWORK_PREFIX),
          `Expected "${value}" to start with "${SCOMP_FRAMEWORK_PREFIX}"`,
        );
      }
    });
  });
});
