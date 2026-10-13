import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export async function discover(root) {
  const packages = [];
  for (const directory of await readdir(resolve(root, "packages"))) {
    const path = resolve(root, "packages", directory);
    const manifest = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
    if (!manifest.private) packages.push({ path, manifest });
  }
  assert.equal(new Set(packages.map(({ manifest }) => manifest.name)).size, packages.length);
  return packages;
}

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

export function resolvedRange(range, name, workspaces) {
  if (!range.startsWith("workspace:")) return range;
  const version = workspaces.get(name);
  assert.ok(version, `Unknown or private workspace dependency: ${name}`);
  const operator = range.slice("workspace:".length);
  assert.ok(["*", "^", "~"].includes(operator), `Unsupported workspace range: ${range}`);
  return operator === "*" ? version : `${operator}${version}`;
}

export function checkManifest(packed, source, workspaces) {
  assert.equal(packed.name, source.name, "Packed name mismatch");
  assert.equal(packed.version, source.version, "Packed version mismatch");
  assert.ok(!packed.private, "Cannot publish a private package");
  for (const field of dependencyFields) {
    const expected = Object.fromEntries(
      Object.entries(source[field] || {}).map(([name, range]) => {
        const resolved = resolvedRange(range, name, workspaces);
        assert.ok(!/^(workspace|file|link|portal):/.test(resolved), `Non-registry dependency: ${name} ${resolved}`);
        return [name, resolved];
      }),
    );
    assert.deepEqual(packed[field] || {}, expected, `${source.name}: invalid packed ${field}`);
  }
}

function exportTargets(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  return Object.values(value).flatMap(exportTargets);
}

export function checkFiles(manifest, files) {
  const targets = [manifest.main, manifest.module, manifest.types, ...exportTargets(manifest.exports)].filter(Boolean);
  assert.ok(targets.length, `${manifest.name}: no public entry points`);
  for (const target of targets) {
    const path = target.replace(/^\.\//, "");
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."), `Unsafe entry point: ${target}`);
    assert.ok(files.has(`package/${path}`), `${manifest.name}: missing packed entry point ${target}`);
  }
}

export async function packAll(root, output, command = run) {
  const packages = await discover(root);
  const workspaces = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
  const artifacts = [];
  for (const { path, manifest } of packages) {
    const filename = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    const file = resolve(output, filename);
    command("bun", ["pm", "pack", "--ignore-scripts", "--filename", file, "--quiet"], path);
    const packed = JSON.parse(command("tar", ["-xOf", file, "package/package.json"], root));
    checkManifest(packed, manifest, workspaces);
    checkFiles(packed, new Set(command("tar", ["-tzf", file], root).split("\n")));
    artifacts.push({ file, manifest: packed });
  }
  return artifacts;
}
