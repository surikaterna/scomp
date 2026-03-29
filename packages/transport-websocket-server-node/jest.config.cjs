const { createJestConfig } = require("../../jest.base.cjs");

module.exports = createJestConfig({
  rootDir: __dirname,
  moduleNameMapper: {
    "^@scomp/core$": "<rootDir>/../core/src",
    "^@scomp/types$": "<rootDir>/../types/src",
    "^@scomp/transport-websocket-client$":
      "<rootDir>/../transport-websocket-client/src",
    "^@scomp/transport-websocket-server-runtime$":
      "<rootDir>/../transport-websocket-server-runtime/src",
  },
});
