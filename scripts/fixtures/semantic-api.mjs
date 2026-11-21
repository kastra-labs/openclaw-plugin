import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const registration = "018ff020-1234-7123-8123-123456789abc";
const checkpoint = "018ff020-1234-7123-8123-123456789abd";
const version = "semantic-event-v1";
export const semanticCases = [
  ["allow", true, "policy_allow"], ["deny", false, "policy_deny"], ["unavailable", false, "evaluate_error"],
  ["contradictory", false, "protocol_error"], ["wrong-operation", false, "protocol_error"],
  ["hold-approved", true, "hold_approved"], ["hold-denied", false, "hold_denied"],
  ["hold-expired", false, "hold_expired"], ["hold-pending", false, "hold_deadline"],
  ["dispatch-unknown", false, "evaluate_error"],
];

export function semanticAPI(hostVersion) {
  const calls = [];
  return { calls, handle(req, res, raw, scenario) {
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: req.url, stage: body?.stage, operation: req.headers["x-kastra-operation-id"], body });
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify({ success: true, data })); };
    assert.equal(req.headers.authorization, "Bearer dh_fixture");
    if (req.url === "/v1/semantic/registrations") {
      assert.deepEqual(body.contract, { complete_content: true, failure_mode: "block", host: "openclaw", host_version: hostVersion,
        max_hold_seconds: 480, phases: ["before_tool_call"], timeout_seconds: 600 });
      assert.equal(body.kind, "agent_hook");
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(body.contract).sort(([a], [b]) => a.localeCompare(b))));
      return send(200, { contract_version: version, registration_id: registration, environment: "dev", revision: 1,
        contract_hash: createHash("sha256").update(canonical).digest("hex"), max_content_bytes: 65536, max_transport_bytes: 1048576 });
    }
    if (req.url === "/v1/semantic/check-event") {
      assert.equal(body.contract_version, version); assert.equal(body.registration_id, registration);
      assert.equal(body.target, "tool_arguments"); assert.equal(body.tool_name, "test_sentinel");
      assert.match(req.headers["x-kastra-operation-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (body.stage === "check") assert.deepEqual(body.arguments, { scenario });
      else assert.equal(body.arguments, undefined);
      if (scenario === "unavailable" || (scenario === "dispatch-unknown" && body.stage === "dispatch")) {
        res.writeHead(503); return res.end("{}");
      }
      const data = { contract_version: version, registration_id: registration,
        operation_id: scenario === "wrong-operation" ? checkpoint : req.headers["x-kastra-operation-id"], stage: body.stage,
        decision: scenario === "deny" ? "DENY" : body.stage === "dispatch" ? "ALLOW" : undefined, status: scenario === "deny" ? "denied" : body.stage === "dispatch" ? "dispatched" : "prepared" };
      if (scenario.startsWith("hold") && body.stage === "check") return send(202, { ...data, decision: "HOLD", status: "held", checkpoint_id: checkpoint,
        hold: { decision: "HOLD", checkpoint_id: checkpoint, title: "Synthetic review", on_timeout: "deny",
          server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() } });
      return send(scenario === "deny" || scenario === "contradictory" ? 403 : body.stage === "dispatch" ? 200 : 202, data);
    }
    assert.ok(req.url.startsWith(`/v1/checkpoints/${checkpoint}`), `unexpected route ${req.url}`);
    if (req.method !== "GET") return send(200, {});
    const status = scenario === "hold-approved" ? "approved" : scenario === "hold-denied" ? "denied" : scenario === "hold-expired" ? "expired" : "pending";
    return send(200, { id: checkpoint, status, effective_decision: status === "pending" ? undefined : status === "approved" ? "ALLOW" : "DENY",
      title: "Synthetic review", on_timeout: "deny", expires_at: new Date(Date.now() + 60000).toISOString() });
  } };
}
