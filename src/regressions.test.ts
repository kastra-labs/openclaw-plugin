import { describe, expect, it, vi } from "vitest";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";
import { KastraClient } from "./kastra-client.js";
import { waitForCheckpoint } from "./hold.js";
import * as holdModule from "./hold.js";

const event = { toolName: "exec", params: { command: "fixture" }, toolCallId: "call-1", runId: "run-1" };
const ctx = { toolName: "exec", channelId: "slack", sessionKey: "session-1", runId: "run-1", toolCallId: "call-1" };
const envelope = { decision: "HOLD", checkpoint_id: "cp-1", title: "Review", on_timeout: "ALLOW" as const, server_now: new Date(0).toISOString(), expires_at: new Date(600000).toISOString() };
const req = { jurisdiction: "us-east", model: "openclaw" };
function fixture(extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const records: any[] = [];
  const client = {
    evaluate: vi.fn(async () => ({ kind: "allow", decisionId: "d-1", ruleId: "r-1" })),
    getCheckpoint: vi.fn(async () => ({ id: "cp-1", status: "pending" })),
    heartbeat: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
  };
  const deps = {
    edgeConfigPath: "/nonexistent/kastra-regression.toml", makeClient: () => client,
    apiPluginConfig: () => ({ deviceToken: "dh_secret", failMode: "closed", governMessages: true, ...config }),
    recordOutcome: (record: unknown) => records.push(record), log: vi.fn(),
    notifyHold: vi.fn(async () => {}), clearHold: vi.fn(async () => {}), ...extra,
  };
  return { client, records, deps, tool: createBeforeToolCallHandler(deps as any), message: createMessageSendingHandler(deps as any) };
}

describe("review enforcement regressions", () => {
  it.each(["tool", "message"] as const)("missing token obeys closed mode for %s", async (surface) => {
    const f = fixture({}, { deviceToken: "" });
    const result = surface === "tool" ? await f.tool(event, ctx) : await f.message({ to: "recipient", content: "hello" }, ctx);
    expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
    expect(f.client.evaluate).not.toHaveBeenCalled();
    expect(f.records).toMatchObject([{ disposition: "unconfigured", decision: "DENY" }]);
  });

  it.each(["tool", "message"] as const)("records each unconfigured open-mode %s bypass", async (surface) => {
    const f = fixture({}, { deviceToken: "", failMode: "open" });
    for (let i = 0; i < 2; i++) {
      const result = surface === "tool" ? await f.tool(event, ctx) : await f.message({ to: "recipient", content: "hello" }, ctx);
      expect(result).toBeUndefined();
    }
    expect(f.records).toHaveLength(2);
    expect(f.records[0]).toMatchObject({ disposition: "unconfigured", decision: "ALLOW" });
  });

  it("preserves full tool input beyond the previous 4 KiB prefix", async () => {
    const f = fixture();
    const command = " ".repeat(5000) + "FORBIDDEN";
    await f.tool({ ...event, params: { command } }, ctx);
    expect(JSON.parse((f.client.evaluate.mock.calls as any)[0][0].attributes["x-kastra-attr-tool-input"])).toEqual({ command });
  });

  it("preserves message tail, recipient and real channel context", async () => {
    const f = fixture();
    const content = " ".repeat(2100) + "FORBIDDEN";
    await f.message({ to: "recipient", content, threadId: "thread-1" }, { ...ctx, accountId: "account-1", conversationId: "conversation-1" });
    const request = (f.client.evaluate.mock.calls as any)[0][0];
    expect(JSON.parse(request.attributes["x-kastra-attr-tool-input"])).toMatchObject({ content, to: "recipient", channel: "slack", threadId: "thread-1" });
    expect(request.attributes["x-kastra-attr-openclaw-channel"]).toBe("slack");
    expect(request.attributes["x-kastra-attr-openclaw-account"]).toBe("account-1");
  });

  it.each(["oversized", "circular", "bigint", "lossy"])("blocks %s input even in open mode", async (kind) => {
    const f = fixture({}, { failMode: "open" });
    const circular: any = {}; circular.self = circular;
    const params = kind === "oversized" ? { command: "x".repeat(300000) } : kind === "circular" ? circular : kind === "bigint" ? { value: 1n } : { value: undefined };
    expect(await f.tool({ ...event, params }, ctx)).toMatchObject({ block: true });
    expect(f.client.evaluate).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({ decision: "DENY", disposition: "invalid_input" });
  });

  it("rejects an array subclass whose toJSON hides policy-relevant values", async () => {
    class HiddenArray extends Array { toJSON() { return []; } }
    const f = fixture({}, { failMode: "open" });
    expect(await f.tool({ ...event, params: { commands: new HiddenArray("FORBIDDEN") } }, ctx)).toMatchObject({ block: true });
    expect(f.client.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { value: NaN }, { value: Infinity }, { value: () => "hidden" }, { value: Symbol("hidden") },
    { value: new Date() }, { value: Array(2) }, { get value() { return "hidden"; } },
    { [Symbol("hidden")]: "FORBIDDEN" },
  ])("rejects other lossy non-JSON input %j", async (params) => {
    const f = fixture({}, { failMode: "open" });
    expect(await f.tool({ ...event, params }, ctx)).toMatchObject({ block: true });
    expect(f.client.evaluate).not.toHaveBeenCalled();
  });

  it.each(["tool", "message"] as const)("records protocol failures as DENY even under open mode for %s", async (surface) => {
    const f = fixture({}, { failMode: "open" });
    const client = new KastraClient("https://fixture.test", "t", async () => new Response(JSON.stringify({ success: true, data: { decision: "unknown" } })));
    f.client.evaluate.mockImplementation(() => client.evaluate(req) as any);
    const result = surface === "tool" ? await f.tool(event, ctx) : await f.message({ to: "recipient", content: "hello" }, ctx);
    expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
    expect(f.records[0]).toMatchObject({ decision: "DENY", disposition: "protocol_error" });
  });

  it("records human approval separately from server timeout allowance", async () => {
    const f = fixture();
    f.client.evaluate.mockResolvedValue({ kind: "hold", envelope } as any);
    for (const status of ["approved", "expired"]) {
      f.client.getCheckpoint.mockResolvedValue({ id: "cp-1", status, effective_decision: "ALLOW", decision_id: "d-hold", rule_id: "r-hold" } as any);
      expect(await f.tool(event, ctx)).toBeUndefined();
    }
    expect(f.records).toMatchObject([
      { decision: "ALLOW", disposition: "hold_approved", checkpointId: "cp-1", decisionId: "d-hold" },
      { decision: "ALLOW", disposition: "hold_expired", checkpointId: "cp-1", decisionId: "d-hold" },
    ]);
  });

  it("distinguishes a policy allow from an evaluate fail-open and retains correlation", async () => {
    const f = fixture({}, { failMode: "open" });
    await f.tool(event, ctx);
    f.client.evaluate.mockRejectedValueOnce(new Error("includes dh_secret and private input"));
    await f.tool({ ...event, toolCallId: "call-2" }, { ...ctx, toolCallId: "call-2" });
    expect(f.records).toMatchObject([
      { decision: "ALLOW", disposition: "policy_allow", decisionId: "d-1", ruleId: "r-1", toolCallId: "call-1", runId: "run-1" },
      { decision: "ALLOW", disposition: "evaluate_error", toolCallId: "call-2" },
    ]);
    expect(JSON.stringify(f.records)).not.toMatch(/dh_secret|private input/);
    expect(JSON.stringify(f.deps.log.mock.calls)).not.toMatch(/dh_secret|private input/);
  });

  it("does not authorize an action if its durable outcome cannot be recorded", async () => {
    const f = fixture({ recordOutcome: () => { throw new Error("disk full"); } }, { failMode: "open" });
    expect(await f.tool(event, ctx)).toMatchObject({ block: true });
  });

  it("blocks an already-cancelled call without evaluating it", async () => {
    const f = fixture({}, { failMode: "open" });
    expect(await f.tool(event, { ...ctx, abortSignal: AbortSignal.abort() } as any)).toMatchObject({ block: true });
    expect(f.client.evaluate).not.toHaveBeenCalled();
    expect(f.records[0]?.disposition).toBe("cancelled");
  });

  it("finishes a pending message HOLD before a shorter host budget", async () => {
    const f = fixture({ hookTimeoutMs: () => 80 }, { failMode: "open" });
    f.client.evaluate.mockResolvedValue({ kind: "hold", envelope } as any);
    const started = Date.now();
    const result = await f.message({ to: "recipient", content: "hello" }, ctx);
    expect(result).toMatchObject({ cancel: true });
    expect(Date.now() - started).toBeLessThan(80);
    expect(f.client.cancel).toHaveBeenCalledWith("cp-1", expect.anything());
  }, 1000);

  it("preserves the configured nine-minute wait when the full host budget is available", async () => {
    const wait = vi.spyOn(holdModule, "waitForCheckpoint").mockResolvedValue({ decision: "DENY", disposition: "hold_deadline" });
    try {
      const f = fixture();
      f.client.evaluate.mockResolvedValue({ kind: "hold", envelope } as any);
      await f.tool(event, ctx);
      expect(wait.mock.calls[0][2]?.maxWaitMs).toBe(540000);
    } finally { wait.mockRestore(); }
  });

  it.each(["notifyHold", "clearHold"])("notification failure in %s cannot turn a HOLD denial into allow", async (name) => {
    const f = fixture({ [name]: () => { throw new Error("IPC failure"); }, holdWaitOpts: { maxWaitMs: 1 } }, { failMode: "open" });
    f.client.evaluate.mockResolvedValue({ kind: "hold", envelope } as any);
    expect(await f.tool(event, ctx)).toMatchObject({ block: true });
  });
});

describe("wire validation regressions", () => {
  it.each([
    [200, { success: true, data: { decision_id: "d", decision: "UNKNOWN", reason: "x" } }],
    [200, { success: false, data: { decision_id: "d", decision: "ALLOW", reason: "x" } }],
    [403, { success: true, data: { decision_id: "d", decision: "ALLOW", reason: "x" } }],
    [200, { success: true, data: { decision: "ALLOW", reason: "x" } }],
    [202, { success: true, data: { ...envelope, on_timeout: "unknown" } }],
    [202, { success: true, data: { ...envelope, expires_at: "bad-date" } }],
    [202, { success: true, data: { ...envelope, decision: "ALLOW" } }],
    [201, { success: true, data: { decision_id: "d", decision: "ALLOW", reason: "x" } }],
  ])("rejects malformed status/envelope %s %j", async (status, body) => {
    const client = new KastraClient("https://fixture.test", "t", async () => new Response(JSON.stringify(body), { status: Number(status) }));
    await expect(client.evaluate(req)).rejects.toThrow();
  });
  it.each([
    { id: "other", status: "approved", effective_decision: "ALLOW" },
    { id: "cp-1", status: "unknown", effective_decision: "ALLOW" },
    { id: "cp-1", status: "denied", effective_decision: "ALLOW" },
    { id: "cp-1", status: "approved" },
    { id: "cp-1", status: "expired", on_timeout: "deny", effective_decision: "ALLOW" },
  ])("rejects unreadable or contradictory checkpoint %j", async (state) => {
    const body = { success: true, data: { title: "Review", on_timeout: "allow", expires_at: envelope.expires_at, ...state } };
    const client = new KastraClient("https://fixture.test", "t", async () => new Response(JSON.stringify(body)));
    await expect(client.getCheckpoint("cp-1")).rejects.toThrow();
  });
});

describe("HOLD finalization regressions", () => {
  it("never allows a pending checkpoint just because the local wait ended", async () => {
    const f = fixture(); let time = 0;
    const result = await waitForCheckpoint(f.client as any, envelope, { now: () => time, sleep: async (ms) => { time += ms; }, maxWaitMs: 10, pollMs: 5 });
    expect(result).toMatchObject({ decision: "DENY", disposition: "hold_deadline" });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
  });
  it("cancellation denies even for a rule with timeout ALLOW", async () => {
    const f = fixture();
    expect(await waitForCheckpoint(f.client as any, envelope, { signal: AbortSignal.abort() })).toMatchObject({ decision: "DENY", disposition: "cancelled" });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.client.getCheckpoint).not.toHaveBeenCalled();
  });
  it.each(["approved", "expired"] as const)("retains server %s provenance", async (status) => {
    const f = fixture();
    f.client.getCheckpoint.mockResolvedValue({ id: "cp-1", status, effective_decision: "ALLOW", decision_id: "d-hold", rule_id: "r-hold", resolved_by: "u1", resolved_by_email: "reviewer@example.test" } as any);
    expect(await waitForCheckpoint(f.client as any, envelope)).toMatchObject({ decision: "ALLOW", status, disposition: `hold_${status}`, decisionId: "d-hold", ruleId: "r-hold", resolvedBy: "u1", resolvedByEmail: "reviewer@example.test" });
    expect(f.client.cancel).not.toHaveBeenCalled();
  });
});
