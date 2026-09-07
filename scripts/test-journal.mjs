import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [, plugin, isolated] = process.argv.slice(2);
const path = join(isolated, "outcomes.jsonl");
const fixture = fileURLToPath(new URL("./fixtures/journal-writer.mjs", import.meta.url));
const { createOutcomeRecorder } = await import(pathToFileURL(join(plugin, "dist/outcomes.js")));
const children = new Set();
function start(mode, writer = "") {
  const child = spawn(process.execPath, [fixture, plugin, path, mode, writer], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child); resolve({ code, signal, stderr }); });
  });
  return { child, ended };
}
try {
  const writers = [0, 1, 2].map(id => start("write", String(id)));
  for (const writer of writers) assert.equal((await writer.ended).code, 0);
  const records = readdirSync(isolated).filter(file => /^outcomes\.jsonl(?:\.\d+)?$/.test(file))
    .flatMap(file => readFileSync(join(isolated, file), "utf8").trim().split("\n").map(JSON.parse));
  assert.equal(records.length, 36);
  assert.equal(new Set(records.map(record => record.toolCallId)).size, 36);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  console.log("PASS journal: concurrent process writes and rotation");

  const owner = start("lock");
  await Promise.race([
    new Promise(resolve => owner.child.stdout.once("data", resolve)),
    owner.ended.then(result => { throw new Error(`Lock owner exited early: ${JSON.stringify(result)}`); }),
  ]);
  owner.child.kill("SIGKILL");
  assert.equal((await owner.ended).signal, "SIGKILL");
  const outcome = { hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow", toolCallId: "after-crash" };
  await assert.rejects(createOutcomeRecorder({ path, timeoutMs: 60 })(outcome));
  assert.equal(statSync(path + ".lock").isDirectory(), true);
  console.log("PASS journal: bounded refusal while crashed owner's lease is fresh");
  await new Promise(resolve => setTimeout(resolve, 11000));
  await createOutcomeRecorder({ path })(outcome);
  assert.equal(JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)).toolCallId, "after-crash");
  console.log("PASS journal: recovery after SIGKILL without manual unlocking");
} finally {
  await Promise.all([...children].map(child => new Promise(resolve => {
    child.once("exit", resolve); child.kill("SIGKILL");
  })));
}
