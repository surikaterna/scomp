import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packAll, run } from "./artifacts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registry = "https://registry.npmjs.org/";

export function isPublished(manifest, command = run) {
  try {
    const args = ["view", `${manifest.name}@${manifest.version}`, "version", "--json"];
    args.push("--registry", registry, "--fetch-retries=0", "--fetch-timeout=30000");
    const version = JSON.parse(command("npm", args, root));
    assert.equal(version, manifest.version, "Unexpected registry version");
    return true;
  } catch (error) {
    // Only a registry E404 means an unpublished version; auth/network errors must stop publication.
    let result;
    try {
      result = JSON.parse(error.stdout?.toString() || "null");
    } catch {
      throw error;
    }
    if (result?.error?.code === "E404") return false;
    throw error;
  }
}

export function publicationOrder(artifacts) {
  const pending = new Map(artifacts.map((artifact) => [artifact.manifest.name, artifact]));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(({ manifest }) => {
      const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
      return !Object.keys(dependencies).some((name) => pending.has(name));
    });
    assert.ok(ready.length, "Circular publication dependencies");
    for (const artifact of ready) {
      pending.delete(artifact.manifest.name);
      ordered.push(artifact);
    }
  }
  return ordered;
}

export function authorize(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Publish only through the release workflow");
  assert.equal(env.GITHUB_REF, "refs/heads/develop");
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "Missing OIDC credentials");
  assert.ok(!env.NODE_AUTH_TOKEN && !env.NPM_TOKEN, "Token fallback is forbidden");
}

export async function publish(artifacts, published = isPublished, command = run) {
  // Read every registry version before the first write, so a failed preflight publishes nothing.
  const candidates = artifacts.filter(({ manifest }) => !published(manifest));
  const ordered = publicationOrder(candidates);
  for (const { manifest } of ordered) {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "Prereleases require an explicit channel policy");
  }
  for (const { file, manifest } of ordered) {
    const args = ["publish", file, "--ignore-scripts", "--access", "public", "--provenance"];
    args.push("--tag", "latest", "--registry", registry);
    command("npm", args, root);
    console.log(`Published ${manifest.name}@${manifest.version}`);
  }
  console.log(`Published ${ordered.length}; skipped ${artifacts.length - ordered.length} existing versions`);
}

async function main() {
  const operation = process.argv[2];
  assert.ok(["check", "publish"].includes(operation), "Usage: release.mjs check|publish");
  if (operation === "publish") authorize();
  const output = await mkdtemp(resolve(tmpdir(), "scompr-release-"));
  try {
    const artifacts = await packAll(root, output);
    console.log(`Checked ${artifacts.length} npm tarballs`);
    if (operation === "publish") await publish(artifacts);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
