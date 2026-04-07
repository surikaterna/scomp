import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(scriptPath);
const fixtureRoot = join(repoRoot, "guardrail-fixtures", "transport-browser-windows-smoke");
const appDir = join(fixtureRoot, "app");
const packageRoot = resolve(repoRoot, "packages/transport-browser-windows");

function runBunCommand(args, cwd) {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

writeFileSync(
  join(appDir, "entry.ts"),
  [
    'import { createBrowserWindowsTransport } from "@scomp/transport-browser-windows";',
    'import "@scomp/transport-browser-windows/worker-entry";',
    "",
    "createBrowserWindowsTransport({ channelName: \"smoke\", mode: \"broadcast-channel\" });",
  ].join("\n"),
);

writeFileSync(
  join(appDir, "worker.ts"),
  'import "@scomp/transport-browser-windows/worker-entry";\n',
);

writeFileSync(
  join(appDir, "rollup.config.mjs"),
  [
    'import { defineConfig } from "rollup";',
    'import resolvePlugin from "@rollup/plugin-node-resolve";',
    'import commonjs from "@rollup/plugin-commonjs";',
    'import typescript from "rollup-plugin-typescript2";',
    "",
    "export default defineConfig([",
    "  {",
    "    input: \"entry.ts\",",
    "    output: { file: \"dist/app.js\", format: \"esm\" },",
    "    plugins: [resolvePlugin({ browser: true, preferBuiltins: false }), commonjs(), typescript()],",
    "  },",
    "  {",
    "    input: \"worker.ts\",",
    "    output: { file: \"dist/worker.js\", format: \"esm\" },",
    "    plugins: [resolvePlugin({ browser: true, preferBuiltins: false }), commonjs(), typescript()],",
    "  },",
    "]);",
    "",
  ].join("\n"),
);

writeFileSync(
  join(appDir, "tsconfig.json"),
  [
    "{",
    '  "compilerOptions": {',
    '    "target": "ES2020",',
    '    "module": "ESNext",',
    '    "moduleResolution": "Bundler",',
    '    "strict": true,',
    '    "skipLibCheck": true,',
    '    "lib": ["ES2020", "DOM", "WebWorker"]',
    "  },",
    '  "include": ["*.ts"]',
    "}",
    "",
  ].join("\n"),
);

const run = async () => {
  const buildPackage = runBunCommand(["x", "tsc", "-b", "tsconfig.json"], packageRoot);

  if (buildPackage.exitCode !== 0) {
    throw new Error(
      [
        "transport-browser-windows build failed before smoke run.",
        buildPackage.stdout.toString(),
        buildPackage.stderr.toString(),
      ].join("\n"),
    );
  }

  const bundleResult = runBunCommand(["x", "rollup", "-c"], appDir);

  if (bundleResult.exitCode !== 0) {
    throw new Error(
      [
        "Bundler smoke build failed.",
        bundleResult.stdout.toString(),
        bundleResult.stderr.toString(),
      ].join("\n"),
    );
  }

  const appOutput = readFileSync(join(appDir, "dist/app.js"), "utf8");
  const workerOutput = readFileSync(join(appDir, "dist/worker.js"), "utf8");

  if (appOutput.length === 0 || workerOutput.length === 0) {
    throw new Error("Bundler smoke output was empty.");
  }

  if (/require\(|node:|process\./.test(appOutput + workerOutput)) {
    throw new Error("Bundler smoke output contains Node-only assumptions.");
  }

  console.log("transport-browser-windows bundler smoke passed");
};

try {
  await run();
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
