import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { checkFiles, checkManifest, packAll, resolvedRange, run } from "./artifacts.mjs";

const versions = new Map([["@test/core", "1.2.3"]]);
const source = { name: "@test/client", version: "1.0.0", peerDependencies: { "@test/core": "workspace:*" } };

test("workspace ranges resolve to source versions", () => {
  for (const [range, expected] of [
    ["*", "1.2.3"],
    ["^", "^1.2.3"],
    ["~", "~1.2.3"],
  ]) {
    assert.equal(resolvedRange(`workspace:${range}`, "@test/core", versions), expected);
  }
  assert.equal(resolvedRange("^2.0.0", "external", versions), "^2.0.0");
  assert.throws(() => resolvedRange("workspace:*", "private", versions), /Unknown or private/);
  assert.throws(() => resolvedRange("workspace:other", "@test/core", versions), /Unsupported/);
});

test("packed peers cannot leak workspace protocols or stale lockfile versions", () => {
  checkManifest({ ...source, peerDependencies: { "@test/core": "1.2.3" } }, source, versions);
  for (const range of ["workspace:*", "1.0.0", "file:../core"]) {
    assert.throws(() => checkManifest({ ...source, peerDependencies: { "@test/core": range } }, source, versions));
  }
  assert.throws(() => checkManifest({ ...source, version: "2.0.0" }, source, versions), /version mismatch/);
});

test("all dependency fields are checked, not only peers", () => {
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    const manifest = { name: "test", version: "1.0.0", [field]: { local: "file:../local" } };
    assert.throws(() => checkManifest(manifest, manifest, versions), /Non-registry/);
  }
  assert.throws(() => checkManifest({ ...source, private: true }, source, versions), /private/);
});

test("packed exports and declaration files must exist", () => {
  const manifest = { name: "test", main: "./dist/index.js", exports: { ".": { types: "./dist/index.d.ts" } } };
  assert.throws(() => checkFiles(manifest, new Set(["package/dist/index.js"])), /missing packed/);
  checkFiles(manifest, new Set(["package/dist/index.js", "package/dist/index.d.ts"]));
  assert.throws(() => checkFiles({ name: "test", main: "../secret" }, new Set()), /Unsafe/);
});

async function writeWorkspace(root, name, manifest) {
  const path = resolve(root, "packages", name);
  await mkdir(resolve(path, "dist"), { recursive: true });
  await writeFile(resolve(path, "package.json"), JSON.stringify(manifest));
  await writeFile(resolve(path, "dist", "index.js"), "export const value = 1;\n");
  return resolve(path, "package.json");
}

test("real Bun tarballs resolve workspace peers and leave source manifests unchanged", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "scompr-pack-test-"));
  const consumer = await mkdtemp(resolve(tmpdir(), "scompr-consumer-test-"));
  try {
    await writeFile(resolve(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    const entry = { files: ["dist"], main: "./dist/index.js" };
    await writeWorkspace(root, "core", { name: "@test/core", version: "1.2.3", ...entry });
    const client = { ...source, ...entry, devDependencies: { "@test/core": "workspace:*" } };
    const path = await writeWorkspace(root, "client", client);
    await writeWorkspace(root, "private", { name: "private", version: "1.0.0", private: true });
    const before = await readFile(path, "utf8");
    run("bun", ["install", "--lockfile-only"], root);
    const artifacts = await packAll(root, root);
    assert.equal(artifacts.length, 2);
    assert.equal(
      artifacts.find(({ manifest }) => manifest.name === source.name).manifest.peerDependencies["@test/core"],
      "1.2.3",
    );
    assert.equal(await readFile(path, "utf8"), before);
    await writeFile(resolve(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    run(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...artifacts.map(({ file }) => file)],
      consumer,
    );
    await writeWorkspace(root, "core", { name: "@test/core", version: "1.2.4", ...entry });
    await assert.rejects(packAll(root, root), /invalid packed/);
    run("bun", ["install", "--lockfile-only"], root);
    await packAll(root, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(consumer, { recursive: true, force: true });
  }
});
