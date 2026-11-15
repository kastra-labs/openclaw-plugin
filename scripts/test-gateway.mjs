import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticAPI, semanticCases } from "./fixtures/semantic-api.mjs";

const [host, pluginRoot, isolated, mode] = process.argv.slice(2);
const semantic = mode?.startsWith("semantic") === true;
const conflict = mode?.slice("semantic-".length);
if (semantic) assert.equal(JSON.parse(readFileSync(join(host, "package.json"))).version, "2026.9.2");
const semanticFixture = semanticAPI();
const here = dirname(fileURLToPath(import.meta.url));
const token = randomBytes(24).toString("hex");
let scenario;
let evaluated = 0;
const api = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  res.setHeader("content-type", "application/json");
  if (semantic) return semanticFixture.handle(req, res, raw, scenario);
  if (req.url === "/v1/evaluate") {
    evaluated++;
    if (scenario === "unavailable") { res.writeHead(503); res.end("{}"); return; }
    if (scenario.startsWith("hold")) {
      res.writeHead(202); res.end(JSON.stringify({ success: true, data: {
        decision: "HOLD", checkpoint_id: "cp-gateway", title: "Fixture", on_timeout: "allow",
        expires_at: new Date(Date.now() + 600000).toISOString(), server_now: new Date().toISOString(),
      } })); return;
    }
    const decision = scenario === "deny" ? "DENY" : scenario === "malformed" ? "UNKNOWN" : "ALLOW";
    res.writeHead(decision === "DENY" ? 403 : 200);
    res.end(JSON.stringify({ success: true, data: { decision_id: scenario === "allow-no-audit" ? "" : "d-gateway", decision, reason: "Fixture" } })); return;
  }
  if (req.method === "GET") {
    const status = scenario === "hold-approved" ? "approved" : scenario === "hold-denied" ? "denied" : scenario === "hold-expired" ? "expired" : "pending";
    res.end(JSON.stringify({ success: true, data: {
      id: "cp-gateway", status, effective_decision: status === "pending" ? undefined : status === "denied" ? "DENY" : "ALLOW",
      rule_id: "", title: "Fixture", on_timeout: "allow", expires_at: new Date().toISOString(),
    } })); return;
  }
  res.end(JSON.stringify({ success: true }));
});
await new Promise((done, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", done); });
let child;
let output = "";
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  child?.kill("SIGTERM");
  api.closeAllConnections();
  setTimeout(() => { child?.kill("SIGKILL"); process.exit(1); }, 5000).unref();
});
try {
  const reservation = createServer();
  await new Promise((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token }, controlUi: { enabled: false } },
    logging: { level: "info", file: join(isolated, "gateway.log") },
    agents: { defaults: { workspace: join(isolated, "workspace"), skipBootstrap: true } },
    browser: { enabled: false }, cron: { enabled: false }, discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    tools: { allow: ["test_sentinel"] },
    plugins: { allow: ["kastra", "kastra-test-sentinel"], slots: { memory: "none" },
      load: { paths: [pluginRoot, join(here, "fixtures/sentinel")] },
      entries: {
        kastra: { enabled: true, config: { apiBaseUrl: `http://127.0.0.1:${api.address().port}`, deviceToken: "dh_fixture", failMode: "closed", holdMaxWaitMs: 100, ...(semantic ? { semanticChecks: true } : {}) } },
        "kastra-test-sentinel": { enabled: true, ...(conflict ? { config: { conflictingHook: conflict } } : {}) },
      },
    },
  }));
  child = spawn(process.execPath, [join(host, "openclaw.mjs"), "gateway", "run", "--allow-unconfigured"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, output.slice(-10000));
    try {
      const response = await fetch(base + "/readyz", { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(ready, output.slice(-10000));
  const cases = semantic ? (conflict ? [[conflict, false, conflict === "rewrite" ? "protocol_error" : undefined]] : semanticCases) : [
    ["allow", true, "policy_allow"], ["deny", false, "policy_deny"], ["unavailable", false, "evaluate_error"],
    ["allow-no-audit", true, "policy_allow"],
    ["malformed", false, "protocol_error"], ["hold-approved", true, "hold_approved"], ["hold-denied", false, "hold_denied"],
    ["hold-expired", true, "hold_expired"], ["hold-pending", false, "hold_deadline"],
  ];
  for (const [name, allow, disposition] of cases) {
    scenario = name; const before = evaluated; const beforeSemantic = semanticFixture.calls.length;
    const response = await fetch(base + "/tools/invoke", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "test_sentinel", args: { scenario }, sessionKey: "main" }), signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    assert.equal(body.result?.details?.executed === true, allow, JSON.stringify({ scenario, body }));
    if (allow) assert.equal(body.result.details.scenario, scenario, "executed arguments differ from the checked invocation");
    if (semantic) {
      assert.equal(evaluated, 0, "semantic mode fell back to legacy evaluation");
      const calls = semanticFixture.calls.slice(beforeSemantic);
      if (conflict) assert.equal(calls.length, 0, "conflicting native hook reached remote authorization");
      else {
        const events = calls.filter(call => call.stage);
        assert.equal(events.filter(call => call.stage === "check").length, 1);
        assert.equal(new Set(events.map(call => call.operation)).size, 1, "recovery changed operation identity");
        if (allow) assert.equal(events.at(-1).stage, "dispatch", "native tool ran without dispatch authorization");
      }
    } else assert.equal(evaluated, before + 1, `${name}: sentinel ran without Kastra evaluation; ${JSON.stringify(body)}`);
    if (!disposition) { console.log(`PASS OpenClaw native before_tool_call ${name}: host blocked; no API call or sentinel`); continue; }
    const last = readFileSync(join(process.env.OPENCLAW_STATE_DIR, "kastra/outcomes.jsonl"), "utf8").trim().split("\n").at(-1);
    assert.equal(JSON.parse(last).disposition, disposition);
    if (semantic && !conflict) {
      assert.equal(JSON.parse(last).registrationId, "018ff020-1234-7123-8123-123456789abc");
      assert.match(JSON.parse(last).operationId, /^[0-9a-f-]{36}$/);
    }
    console.log(`PASS gateway /tools/invoke${semantic ? " semantic" : ""}: ${name}`);
  }
} catch (error) {
  throw new Error(`${error}\n${output.slice(-10000).split(token).join("[fixture-token]")}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(done => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  }
  api.closeAllConnections();
  await new Promise(done => api.close(done));
}
