// No Edge login, model credentials, external channels, or production state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = resolve(process.argv[2] ?? join(root, "node_modules/openclaw"));
const temporary = mkdtempSync(join(tmpdir(), "kastra-openclaw-integration-"));
function run(args, cwd, env = process.env) {
  const result = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const [packed] = JSON.parse(run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", temporary], root));
  const names = packed.files.map(file => file.path);
  assert.ok(names.includes("dist/index.js") && names.includes("openclaw.plugin.json"));
  assert.ok(!names.some(name => name.startsWith("node_modules/") || name.endsWith(".test.js")));
  const install = join(temporary, "installation");
  mkdirSync(install);
  run(["npm", "install", "--prefix", install, "--prefer-offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(temporary, packed.filename)], temporary);
  const plugin = join(install, "node_modules/@kastra_labs/openclaw");
  assert.equal(JSON.parse(readFileSync(join(plugin, "package.json"))).version, packed.version);
  const env = {
    PATH: process.env.PATH, HOME: join(temporary, "home"), TMPDIR: tmpdir(),
    OPENCLAW_STATE_DIR: join(temporary, "state"), OPENCLAW_CONFIG_PATH: join(temporary, "openclaw.json"),
    OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_DISABLE_DISCOVERY: "1",
    KASTRA_CONFIG: join(temporary, "missing.toml"), KASTRA_EDGE_DAEMON_SOCKET: join(temporary, "missing.sock"),
  };
  mkdirSync(env.HOME);
  mkdirSync(env.OPENCLAW_STATE_DIR);
  const runs = ["test-runtime.mjs", "test-gateway.mjs", "test-gateway.mjs"];
  for (const [index, script] of runs.entries()) {
    const state = join(temporary, "run-" + index);
    mkdirSync(state);
    const runEnv = { ...env, OPENCLAW_STATE_DIR: join(state, "state"), OPENCLAW_CONFIG_PATH: join(state, "openclaw.json") };
    mkdirSync(runEnv.OPENCLAW_STATE_DIR);
    process.stdout.write(run([process.execPath, join(root, "scripts", script), host, plugin, state], root, runEnv));
  }
  console.log(`Packed plugin ${packed.version}: installation, host, and gateway checks passed`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
