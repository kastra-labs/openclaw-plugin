import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyReleaseArtifact(directory, expected, ref = "") {
  const files = readdirSync(directory).filter(file => file.endsWith(".tgz"));
  assert.equal(files.length, 1, "Expected exactly one release tarball");
  const packed = JSON.parse(execFileSync("tar", ["-xOf", resolve(directory, files[0]), "package/package.json"], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  }));
  assert.ok(typeof packed.version === "string" && packed.version.length > 0, "Packed manifest requires a version");
  assert.equal(packed.name, expected.name, "Packed manifest name differs from source");
  assert.equal(packed.version, expected.version, "Packed manifest version differs from source");
  if (ref.startsWith("refs/tags/")) assert.equal(ref, `refs/tags/v${packed.version}`, "Release tag differs from packed version");
  return packed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  const packed = verifyReleaseArtifact(process.argv[2] ?? "release", source, process.env.GITHUB_REF);
  console.log(`Verified release artifact: ${packed.name}@${packed.version}`);
}
