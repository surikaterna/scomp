import assert from "node:assert/strict";
import { test } from "node:test";
import { authorize, isPublished, publicationOrder, publish } from "./release.mjs";

const artifact = (name, peers = {}, version = "1.0.0") => ({
  file: `/checked/${name}.tgz`,
  manifest: { name, version, peerDependencies: peers },
});

test("runtime and peer dependencies publish before dependents; cycles fail closed", () => {
  const core = artifact("core", { types: "1.0.0" });
  const client = artifact("client", { core: "1.0.0" });
  const types = artifact("types");
  assert.deepEqual(publicationOrder([client, core, types]), [types, core, client]);
  assert.throws(() => publicationOrder([artifact("a", { b: "1.0.0" }), artifact("b", { a: "1.0.0" })]), /Circular/);
});

test("registry E404 is missing; network/auth/malformed responses are not", () => {
  assert.equal(
    isPublished(artifact("core").manifest, () => '"1.0.0"'),
    true,
  );
  const failure = (code) => () => {
    throw Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });
  };
  assert.equal(isPublished(artifact("core").manifest, failure("E404")), false);
  assert.throws(() => isPublished(artifact("core").manifest, failure("E401")), /E401/);
  assert.throws(() => isPublished(artifact("core").manifest, () => "not JSON"));
  assert.throws(() => isPublished(artifact("core").manifest, () => '"2.0.0"'), /Unexpected/);
});

test("publishes checked tarballs, skips existing versions, and never invokes repacking", async () => {
  const calls = [];
  await publish(
    [artifact("client", { core: "1.0.0" }), artifact("core"), artifact("types")],
    ({ name }) => name === "types",
    (command, args) => calls.push([command, args]),
  );
  assert.deepEqual(
    calls.map(([, args]) => args[1]),
    ["/checked/core.tgz", "/checked/client.tgz"],
  );
  for (const [command, args] of calls) {
    assert.equal(command, "npm");
    assert.equal(args[0], "publish");
    assert.ok(args.includes("--ignore-scripts") && args.includes("--provenance"));
  }
});

test("failed registry preflight and unsupported prereleases cause zero writes", async () => {
  let writes = 0;
  await assert.rejects(
    publish(
      [artifact("a"), artifact("b")],
      ({ name }) => {
        if (name === "b") throw new Error("offline");
        return false;
      },
      () => writes++,
    ),
    /offline/,
  );
  await assert.rejects(
    publish(
      [artifact("a"), artifact("b", {}, "1.0.1-pre.0")],
      () => false,
      () => writes++,
    ),
    /Prereleases/,
  );
  assert.equal(writes, 0);
});

test("a failed publish stops subsequent writes", async () => {
  const calls = [];
  await assert.rejects(
    publish(
      [artifact("a"), artifact("b")],
      () => false,
      (_, args) => {
        calls.push(args[1]);
        throw new Error("publication failed");
      },
    ),
    /publication failed/,
  );
  assert.deepEqual(calls, ["/checked/a.tgz"]);
});

test("publication requires the owned workflow and OIDC without token fallback", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/develop",
    ACTIONS_ID_TOKEN_REQUEST_URL: "url",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "token",
  };
  authorize(env);
  assert.throws(() => authorize({}), /release workflow/);
  assert.throws(() => authorize({ ...env, GITHUB_REF: "refs/heads/feature/test" }));
  assert.throws(() => authorize({ ...env, NODE_AUTH_TOKEN: "secret" }), /Token fallback/);
  assert.throws(() => authorize({ ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }), /OIDC/);
});
