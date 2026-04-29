const { createJestConfig } = require("../../jest.base.cjs");

module.exports = createJestConfig({
  rootDir: __dirname,
  testMatch: ["**/*.spec.ts", "!**/*.bun.spec.ts"],
  moduleNameMapper: {
    "^@scomp/core$": "<rootDir>/../core/src",
    "^@scomp/types$": "<rootDir>/../types/src",
    "^@scomp/transport-shared$": "<rootDir>/../transport-shared/src",
    "^@scomp/transport-websocket-client$": "<rootDir>/../transport-websocket-client/src",
    "^@scomp/transport-websocket-server-runtime$": "<rootDir>/../transport-websocket-server-runtime/src",
  },
});
