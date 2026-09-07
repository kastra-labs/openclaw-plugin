import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [host, pluginRoot, isolated] = process.argv.slice(2);
const version = JSON.parse(readFileSync(join(host, "package.json"))).version;
const wire = JSON.parse(readFileSync(new URL("./fixtures/api-responses.json", import.meta.url)));
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}\n");

// These internals are not SDK exports. A changed host must fail this adapter,
// never silently substitute a fake runner or skip the compatibility checks.
async function hostFunction(prefix, name) {
  for (const file of readdirSync(join(host, "dist"))) {
    if (!file.startsWith(prefix) || !file.endsWith(".js")) continue;
    if (!readFileSync(join(host, "dist", file), "utf8").includes(`function ${name}(`)) continue;
    const module = await import(pathToFileURL(join(host, "dist", file)).href);
    const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
    if (fn) return fn;
  }
  throw new Error(`OpenClaw ${version}: update adapter for ${name}`);
}
const loadPlugins = await hostFunction("loader-", "loadOpenClawPlugins");
const wrapTool = await hostFunction("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook");
const { getGlobalHookRunner } = await import(pathToFileURL(join(host, "dist/plugin-sdk/plugin-runtime.js")).href);
let scenario;
let requests = [];
let errors = [];
const api = createServer(async (req, res) => {
  const active = scenario;
  const rows = requests;
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    rows.push({ method: req.method, url: req.url, body });
    assert.equal(req.headers.authorization, "Bearer dh_fixture");
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (req.url === "/prefix/v1/evaluate") {
      if (active.apiError) { res.writeHead(active.apiError); res.end(JSON.stringify({ success: false, error: "Fixture HTTP failure" })); return; }
      if (active.stallEvaluate) return;
      if (active.hold) {
        res.writeHead(202);
        res.end(JSON.stringify({ success: true, data: {
          ...wire.hold.data, checkpoint_id: "cp-fixture", title: "Fixture", on_timeout: (active.onTimeout ?? "DENY").toLowerCase(),
          server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
        } })); return;
      }
      const attrs = body.attributes;
      assert.ok(!JSON.stringify(body).includes("dh_fixture"), "credential leaked into request body");
      const decision = active.contentRule ? (attrs["x-kastra-attr-tool-input"].includes("FORBIDDEN") ? "DENY" : "ALLOW") :
        active.channelRule ? (attrs["x-kastra-attr-openclaw-channel"] === "slack" ? "DENY" : "ALLOW") : active.decision ?? "ALLOW";
      res.writeHead(active.httpStatus ?? (decision === "DENY" ? 403 : 200));
      res.end(JSON.stringify({ success: active.success ?? true, data: {
        ...(active.noAudit ? wire.allowWithoutAudit.data : {}), decision, decision_id: active.noAudit ? "" : "d-fixture", reason: "Fixture", matched_rule: { id: active.noAudit ? "" : "r-fixture" },
      } })); return;
    }
    if (req.method === "GET") {
      if (active.stallCheckpoint) return;
      const pending = active.deferMs && Date.now() - active.started < active.deferMs;
      const status = pending ? "pending" : active.status ?? "pending";
      res.end(JSON.stringify({ success: true, data: {
        ...wire.approved.data, id: active.wrongId ? "wrong" : "cp-fixture", status,
        effective_decision: status === "pending" ? undefined : active.effectiveDecision,
        decision_id: active.noAudit ? undefined : "d-hold", rule_id: active.noAudit ? "" : "r-hold", resolved_by: active.resolvedBy,
        title: "Fixture", on_timeout: (active.onTimeout ?? "DENY").toLowerCase(), expires_at: new Date().toISOString(),
      } })); return;
    }
    if (req.url.endsWith("/heartbeat") && active.heartbeatError) { res.writeHead(active.heartbeatError); res.end("{}"); return; }
    if (req.url.endsWith("/cancel") && active.cancelError) { res.writeHead(active.cancelError); res.end("{}"); return; }
    res.end(JSON.stringify({ success: true }));
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end("{}"); }
});
await new Promise((done, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", done); });
const base = `http://127.0.0.1:${api.address().port}/prefix`;
const journal = join(process.env.OPENCLAW_STATE_DIR, "kastra/outcomes.jsonl");
function outcomes() { try { return readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
const cases = [
  { name: "policy allow", allow: true, disposition: "policy_allow" },
  { name: "policy deny", decision: "DENY", disposition: "policy_deny" },
  { name: "allow without audit metadata", noAudit: true, allow: true, disposition: "policy_allow" },
  { name: "deny without audit metadata", noAudit: true, decision: "DENY", disposition: "policy_deny" },
  { name: "approved without audit metadata", noAudit: true, hold: true, status: "approved", effectiveDecision: "ALLOW", allow: true, disposition: "hold_approved" },
  { name: "transient heartbeat failure", hold: true, heartbeatError: 503, status: "approved", effectiveDecision: "ALLOW", allow: true, disposition: "hold_approved" },
  { name: "rejected heartbeat and cancellation", hold: true, heartbeatError: 401, cancelError: 503, disposition: "hold_error" },
  ...["open", "closed"].flatMap(failMode => [
    { name: `no token ${failMode}`, noToken: true, failMode, allow: failMode === "open", disposition: "unconfigured" },
    { name: `503 ${failMode}`, apiError: 503, failMode, allow: failMode === "open", disposition: "evaluate_error" },
    { name: `401 ${failMode}`, apiError: 401, failMode, allow: failMode === "open", disposition: "evaluate_error" },
    ...[400, 403, 404, 408, 422, 429].map(apiError => ({ name: `${apiError} ${failMode}`, apiError, failMode, allow: failMode === "open", disposition: "evaluate_error" })),
    { name: `unknown decision ${failMode}`, decision: "UNKNOWN", failMode, disposition: "protocol_error" },
    { name: `contradictory 403 ${failMode}`, httpStatus: 403, failMode, disposition: "protocol_error" },
    { name: `success false ${failMode}`, success: false, failMode, disposition: "protocol_error" },
  ]),
  ...[
    ["approved", "ALLOW", "DENY", true], ["denied", "DENY", "DENY", false],
    ["expired", "ALLOW", "ALLOW", true], ["expired", "DENY", "DENY", false],
    ["cancelled", "DENY", "ALLOW", false], ["abandoned", "DENY", "ALLOW", false],
  ].map(([status, effectiveDecision, onTimeout, allow]) => ({ name: `hold ${status} ${effectiveDecision}`, hold: true, status, effectiveDecision, onTimeout, allow, disposition: `hold_${status}` })),
  { name: "pending timeout allow", hold: true, onTimeout: "ALLOW", holdMs: 35, disposition: "hold_deadline" },
  { name: "pending timeout deny", hold: true, holdMs: 35, disposition: "hold_deadline" },
  { name: "wrong checkpoint", hold: true, wrongId: true, status: "approved", effectiveDecision: "ALLOW", disposition: "hold_error" },
  { name: "contradictory checkpoint", hold: true, status: "denied", effectiveDecision: "ALLOW", disposition: "hold_error" },
  { name: "input suffix", contentRule: true, params: { command: " ".repeat(5000) + "FORBIDDEN" }, disposition: "policy_deny" },
  { name: "oversized input", failMode: "open", params: { command: "x".repeat(300000) }, disposition: "invalid_input" },
  { name: "channel rule", channelRule: true, disposition: "policy_deny" },
  { name: "stalled evaluate", stallEvaluate: true, failMode: "open", hookMs: 500, deadline: true },
  { name: "stalled checkpoint", hold: true, stallCheckpoint: true, failMode: "open", hookMs: 500, deadline: true },
];
try {
  for (const message of [false, true]) {
    for (const spec of cases) {
      scenario = { ...spec, started: Date.now() }; requests = []; errors = [];
      const logs = [];
      const logger = Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level, text => logs.push(String(text))]));
      const hook = message ? "message_sending" : "before_tool_call";
      const config = {
        logging: { level: "silent", consoleLevel: "silent", file: join(isolated, "runtime.log") },
        plugins: { enabled: true, allow: ["kastra"], load: { paths: [pluginRoot] }, entries: { kastra: {
          enabled: true, ...(spec.hookMs ? { hooks: { timeouts: { [hook]: spec.hookMs } } } : {}),
          config: { apiBaseUrl: base, ...(!spec.noToken ? { deviceToken: "dh_fixture" } : {}), failMode: spec.failMode ?? "closed", governMessages: true, holdMaxWaitMs: spec.holdMs ?? 500 },
        } } },
      };
      const registry = await loadPlugins({ config, workspaceDir: isolated, onlyPluginIds: ["kastra"], cache: false, logger });
      assert.equal(registry.plugins.find(entry => entry.id === "kastra")?.status, "loaded", JSON.stringify({ diagnostics: registry.diagnostics, logs }));
      assert.equal(registry.typedHooks.filter(entry => entry.pluginId === "kastra").length, 2);
      const before = outcomes().length;
      let executed = false;
      const started = Date.now();
      const ctx = { channelId: message ? "slack" : "C-fixture", accountId: "account", conversationId: "conversation", sessionKey: "agent:main:slack:channel:C-fixture", runId: "run-fixture" };
      if (message) {
        const result = await getGlobalHookRunner().runMessageSending({ to: "recipient", content: spec.params?.command ?? "hello", threadId: "thread" }, ctx);
        executed = !result?.cancel;
      } else {
        const tool = wrapTool({
          name: "exec", description: "In-memory sentinel only", parameters: { type: "object" },
          execute: async () => { executed = true; return { content: [{ type: "text", text: "executed" }] }; },
        }, { ...ctx, agentId: "main", config, loopDetection: { enabled: false } }, { emitDiagnostics: false });
        try { await tool.execute("call-fixture", spec.params ?? { command: "fixture" }); }
        catch (error) { assert.match(String(error), /Kastra|blocked/i); }
      }
      const elapsed = Date.now() - started;
      assert.equal(executed, spec.allow === true, `${hook}: ${spec.name}; ${JSON.stringify(logs)}`);
      assert.deepEqual(errors, []);
      const records = outcomes().slice(before);
      assert.equal(records.length, 1, `${hook}: ${spec.name} missing durable outcome`);
      assert.equal(records[0].hook, hook);
      assert.equal(records[0].decision, executed ? "ALLOW" : "DENY");
      if (spec.disposition) assert.equal(records[0].disposition, spec.disposition, spec.name);
      assert.equal(records[0].runId, "run-fixture");
      if (!message) assert.equal(records[0].toolCallId, "call-fixture");
      if (spec.disposition === "policy_allow") assert.equal(records[0].decisionId, spec.noAudit ? undefined : "d-fixture");
      if (spec.heartbeatError) assert.equal(records[0].heartbeatFailures, 1);
      if (spec.cancelError) assert.equal(records[0].cancelFailed, true);
      if (!message && requests.some(row => row.url.endsWith("/evaluate"))) {
        const attrs = requests.find(row => row.url.endsWith("/evaluate")).body.attributes;
        assert.equal(attrs["x-kastra-attr-openclaw-channel"], "slack");
        assert.equal(attrs["x-kastra-attr-tool-use-id"], "call-fixture");
        assert.equal(attrs["x-kastra-attr-turn-id"], "run-fixture");
      }
      if (spec.disposition?.startsWith("hold_")) assert.equal(records[0].checkpointId, "cp-fixture");
      if (spec.deadline) {
        assert.ok(elapsed < spec.hookMs, `missed host budget: ${elapsed}`);
        if (spec.stallCheckpoint) assert.equal(records[0].checkpointId, "cp-fixture", JSON.stringify({ records, requests }));
        const activity = () => requests.filter(row => row.method === "GET" || row.url.endsWith("/heartbeat")).length;
        const count = activity();
        await new Promise(done => setTimeout(done, 30));
        assert.equal(activity(), count, "polling continued after hook completion");
        assert.ok(!logs.some(line => /hook.*timed out/i.test(line)), "host timed out before plugin");
      }
      console.log(`PASS ${hook}: ${spec.name}`);
    }
  }
  // Exercises the authored message timeout against the real 15-second host default.
  scenario = { hold: true, status: "denied", effectiveDecision: "DENY", deferMs: 15500, started: Date.now() };
  const config = { plugins: { enabled: true, allow: ["kastra"], load: { paths: [pluginRoot] }, entries: { kastra: { enabled: true, config: { apiBaseUrl: base, deviceToken: "dh_fixture", governMessages: true, holdMaxWaitMs: 25000 } } } } };
  await loadPlugins({ config, workspaceDir: isolated, onlyPluginIds: ["kastra"], cache: false });
  const result = await getGlobalHookRunner().runMessageSending({ to: "recipient", content: "delayed denial" }, { channelId: "slack" });
  assert.equal(result?.cancel, true, "default host timeout released pending message");
  assert.equal(outcomes().at(-1).disposition, "hold_denied");
  console.log(`PASS OpenClaw ${version}: ${cases.length * 2 + 1} real-host cases`);
} finally {
  api.closeAllConnections();
  await new Promise(done => api.close(done));
}
