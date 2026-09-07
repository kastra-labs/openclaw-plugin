import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [plugin, path, mode, writer] = process.argv.slice(2);
if (mode === "lock") {
  const lockfile = createRequire(join(plugin, "package.json"))("proper-lockfile");
  await lockfile.lock(path, { realpath: false, stale: 10000, update: 2000 });
  process.stdout.write("locked\n");
  setInterval(() => {}, 1000);
} else {
  const { createOutcomeRecorder } = await import(pathToFileURL(join(plugin, "dist/outcomes.js")));
  const record = createOutcomeRecorder({ path, maxBytes: 2500, archives: 20, timeoutMs: 5000 });
  for (let i = 0; i < 12; i++) await record({ hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow", toolCallId: `${writer}-${i}` });
}
