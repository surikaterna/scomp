const { createJestConfig } = require("../../jest.base.cjs");

module.exports = createJestConfig({
  rootDir: __dirname,
  moduleNameMapper: {
    "^@scomp/core$": "<rootDir>/../core/src",
    "^@scomp/types$": "<rootDir>/../types/src",
    "^@scomp/transport-websocket-shared$": "<rootDir>/../transport-websocket-shared/src",
  },
});
