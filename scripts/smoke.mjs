// Backward-compatible entry point for the no-login, packed-plugin smoke suite.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) throw new Error("Usage: node scripts/smoke.mjs (no login or command argument required)");
const result = spawnSync("npm", ["run", "test:integration"], {
  cwd: dirname(dirname(fileURLToPath(import.meta.url))), stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
