import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixturesRoot = join(process.cwd(), "guardrail-fixtures");
const badDir = join(fixturesRoot, "bad");
const goodNodeDir = join(fixturesRoot, "good-node");
const goodBunDir = join(fixturesRoot, "good-bun");

rmSync(fixturesRoot, { recursive: true, force: true });
mkdirSync(badDir, { recursive: true });
mkdirSync(goodNodeDir, { recursive: true });
mkdirSync(goodBunDir, { recursive: true });

writeFileSync(
  join(badDir, "server.ts"),
  `import { createServer } from "node:http";
import { createWebSocketServerTransport } from "@scomp/transport-websocket-server";

const server = createServer();
createWebSocketServerTransport({ server, outbound: { url: "ws://127.0.0.1:3000" } });
`
);

writeFileSync(
  join(goodNodeDir, "server.ts"),
  `import { createServer } from "node:http";
import { createWebSocketServerTransport } from "@scomp/transport-websocket-server-node";

const server = createServer();
createWebSocketServerTransport({ server, outbound: { url: "ws://127.0.0.1:3000" } });
`
);

writeFileSync(
  join(goodBunDir, "server.ts"),
  `import { createWebSocketServerTransport } from "@scomp/transport-websocket-server";

createWebSocketServerTransport({
  port: 3000,
  outbound: { url: "ws://127.0.0.1:3000" }
});
`
);

const run = async () => {
  const badResult = Bun.spawnSync([
    "bun",
    "./check-websocket-server-imports.mjs",
    "--path",
    "guardrail-fixtures/bad"
  ]);

  if (badResult.exitCode === 0) {
    throw new Error("Expected bad fixture to fail guardrail check.");
  }

  const goodNodeResult = Bun.spawnSync([
    "bun",
    "./check-websocket-server-imports.mjs",
    "--path",
    "guardrail-fixtures/good-node"
  ]);

  if (goodNodeResult.exitCode !== 0) {
    throw new Error("Expected good Node fixture to pass guardrail check.");
  }

  const goodBunResult = Bun.spawnSync([
    "bun",
    "./check-websocket-server-imports.mjs",
    "--path",
    "guardrail-fixtures/good-bun"
  ]);

  if (goodBunResult.exitCode !== 0) {
    throw new Error("Expected good Bun fixture to pass guardrail check.");
  }

  console.log("websocket-server import guardrail fixtures passed");
};

try {
  await run();
} finally {
  rmSync(fixturesRoot, { recursive: true, force: true });
}
