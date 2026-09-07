import assert from "node:assert/strict";
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseArtifact } from "./verify-release.mjs";

const expected = { name: "@kastra_labs/openclaw", version: "0.2.0" };
function fixture(manifest, run) {
  const dir = mkdtempSync(join(tmpdir(), "kastra-release-"));
  try {
    mkdirSync(join(dir, "package"));
    mkdirSync(join(dir, "release"));
    writeFileSync(join(dir, "package/package.json"), JSON.stringify(manifest));
    // The filename deliberately cannot substitute for inspecting the manifest.
    execFileSync("tar", ["-czf", join(dir, "release/artifact.tgz"), "-C", dir, "package/package.json"]);
    run(join(dir, "release"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("accepts a matching tag and packed manifest", () => fixture(expected, dir => {
  assert.equal(verifyReleaseArtifact(dir, expected, "refs/tags/v0.2.0").version, "0.2.0");
}));
test("rejects a tag/version mismatch", () => fixture(expected, dir => {
  assert.throws(() => verifyReleaseArtifact(dir, expected, "refs/tags/v0.3.0"), /tag/i);
}));
test("rejects a packed version differing from source even on manual runs", () => fixture({ ...expected, version: "0.1.0" }, dir => {
  assert.throws(() => verifyReleaseArtifact(dir, expected, "refs/heads/main"), /manifest/i);
}));
test("rejects the wrong package identity", () => fixture({ ...expected, name: "fixture-other" }, dir => {
  assert.throws(() => verifyReleaseArtifact(dir, expected, "refs/tags/v0.2.0"), /manifest/i);
}));
test("permits manual branch runs with matching manifests", () => fixture(expected, dir => {
  assert.equal(verifyReleaseArtifact(dir, expected, "refs/heads/main").version, "0.2.0");
}));
test("rejects ambiguous release directories", () => fixture(expected, dir => {
  writeFileSync(join(dir, "unexpected.tgz"), "fixture");
  assert.throws(() => verifyReleaseArtifact(dir, expected), /one/i);
}));
