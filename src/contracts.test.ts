import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { KastraAuthError, KastraClient, KastraProtocolError } from "./kastra-client.js";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";

const wire = JSON.parse(readFileSync(new URL("../scripts/fixtures/api-responses.json", import.meta.url), "utf8"));
const request = { jurisdiction: "us", model: "openclaw" };
function client(status: number, body: unknown) {
  return new KastraClient("https://fixture.test", "dh_fixture", async () => new Response(JSON.stringify(body), { status }));
}

describe("evaluation wire compatibility", () => {
  it.each(["allow", "deny", "ALLOW", "DENY"])("normalizes HOLD on_timeout=%s", async on_timeout => {
    const result = await client(202, { ...wire.hold, data: { ...wire.hold.data, on_timeout } }).evaluate(request);
    expect(result).toMatchObject({ kind: "hold", envelope: { on_timeout: on_timeout.toUpperCase() } });
  });
  it.each([undefined, "", null])("accepts absent evaluation correlation %s", async decision_id => {
    expect(await client(200, { ...wire.allowWithoutAudit, data: { ...wire.allowWithoutAudit.data, decision_id } }).evaluate(request))
      .toMatchObject({ kind: "allow", decisionId: undefined });
  });
  it.each([200, 403])("never loses a policy DENY without an audit ID on HTTP %s", async status => {
    expect(await client(status, { success: true, data: { decision: "DENY", reason: "Fixture", decision_id: "", matched_rule: { id: "" } } }).evaluate(request))
      .toMatchObject({ kind: "deny", decisionId: undefined, ruleId: undefined });
  });
  it("accepts empty optional checkpoint metadata without weakening terminal validation", async () => {
    expect(await client(200, wire.approved).getCheckpoint(wire.approved.data.id)).toMatchObject({ status: "approved", rule_id: undefined });
    await expect(client(200, { ...wire.approved, data: { ...wire.approved.data, effective_decision: "DENY" } }).getCheckpoint(wire.approved.data.id)).rejects.toBeInstanceOf(KastraProtocolError);
  });
  it.each([42, "bad id", { id: "hidden" }])("still rejects invalid nonempty correlation %j", async decision_id => {
    await expect(client(200, { ...wire.allowWithoutAudit, data: { ...wire.allowWithoutAudit.data, decision_id } }).evaluate(request)).rejects.toBeInstanceOf(KastraProtocolError);
  });

  for (const surface of ["tool", "message"] as const) {
    for (const failMode of ["open", "closed"] as const) {
      it.each([400, 401, 403, 404, 408, 422, 429, 500, 503])(`${surface} honors ${failMode} for HTTP %s errors`, async status => {
        const records: any[] = [];
        const deps = {
          edgeConfigPath: "/nonexistent/fixture.toml", apiPluginConfig: () => ({ deviceToken: "dh_fixture", failMode, governMessages: true }),
          makeClient: () => client(status, { success: false, error: "Fixture HTTP failure" }),
          recordOutcome: (outcome: unknown) => { records.push(outcome); }, log: vi.fn(),
        };
        const result = surface === "tool" ? await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {} }) :
          await createMessageSendingHandler(deps)({ content: "Fixture", to: "recipient" }, { channelId: "slack" });
        if (failMode === "open") expect(result).toBeUndefined();
        else expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
        expect(records).toMatchObject([{ disposition: "evaluate_error", decision: failMode === "open" ? "ALLOW" : "DENY" }]);
      });
    }
  }
  it.each(["heartbeat", "cancel"] as const)("%s reports rejected authentication", async action => {
    await expect(client(401, { success: false })[action]("cp-fixture")).rejects.toBeInstanceOf(KastraAuthError);
  });
  it.each(["heartbeat", "cancel"] as const)("%s reports transport failure", async action => {
    const failure = new Error("Fixture transport failure");
    const c = new KastraClient("https://fixture.test", "dh_fixture", async () => { throw failure; });
    await expect(c[action]("cp-fixture")).rejects.toBe(failure);
  });
});
