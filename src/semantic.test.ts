import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBeforeToolCallHandler, createMessageSendingHandler, type HandlerDeps } from "./handler.js";
import { SEMANTIC_CONTRACT, SEMANTIC_HOST_VERSION, SEMANTIC_VERSION, SemanticClient, newOperationId } from "./semantic-client.js";
import type { Outcome } from "./outcomes.js";

const registration = "018ff020-1234-7123-8123-123456789abc";
const checkpoint = "018ff020-1234-7123-8123-123456789abd";
const event = { toolName: "exec", params: { command: "echo synthetic", text: "é<>&" } };
const ok = (data: unknown, status = (data as { status?: string })?.status === "prepared" ? 202 : 200) => new Response(JSON.stringify({ success: true, data }), { status });
function registrationData() {
  return { contract_version: SEMANTIC_VERSION, registration_id: registration, environment: "dev", revision: 1,
    contract_hash: createHash("sha256").update(JSON.stringify(SEMANTIC_CONTRACT)).digest("hex"), max_content_bytes: 65536, max_transport_bytes: 1048576 };
}
function fixture(options: {
  respond?: (body: any, init: RequestInit) => Response | Promise<Response>;
  registration?: Record<string, unknown>; state?: string; deps?: Partial<HandlerDeps>; config?: Record<string, unknown>;
} = {}) {
  const requests: { path: string; body: any; init: RequestInit }[] = [];
  const records: Outcome[] = [];
  const legacy = vi.fn();
  const fetcher: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body, init });
    if (path.endsWith("registrations")) return ok({ ...registrationData(), ...options.registration });
    if (path.endsWith("check-event")) return options.respond?.(body, init) ?? ok({
      contract_version: SEMANTIC_VERSION, registration_id: registration,
      operation_id: new Headers(init.headers).get("X-Kastra-Operation-Id"), stage: body.stage,
      decision: body.stage === "dispatch" ? "ALLOW" : undefined, status: body.stage === "dispatch" ? "dispatched" : "prepared",
    });
    if (init.method === "POST") return new Response(null, { status: 204 });
    const state = options.state ?? "approved";
    return ok({ id: checkpoint, status: state, effective_decision: state === "pending" ? undefined : state === "approved" ? "ALLOW" : "DENY",
      title: "Synthetic approval", expires_at: new Date(Date.now() + 10000).toISOString(), on_timeout: "DENY" });
  };
  const deps: HandlerDeps = {
    edgeConfigPath: "/nonexistent/semantic-fixture.toml", hostVersion: () => SEMANTIC_HOST_VERSION, toolHookCount: () => 1,
    apiPluginConfig: () => ({ semanticChecks: true, failMode: "closed", deviceToken: "dh_synthetic", environment: "dev", ...options.config }),
    makeClient: legacy, makeSemanticClient: () => new SemanticClient("http://127.0.0.1:1", "dh_synthetic", fetcher),
    recordOutcome: record => { records.push(record); }, log: vi.fn(), notifyHold: async () => {}, clearHold: async () => {},
    holdWaitOpts: { pollMs: 1, maxWaitMs: 15, cleanupMs: 1 }, ...options.deps,
  };
  return { handler: createBeforeToolCallHandler(deps), deps, requests, records, legacy };
}
function reply(body: any, init: RequestInit, decision: string | undefined = body.stage === "dispatch" ? "ALLOW" : undefined, status = body.stage === "dispatch" ? "dispatched" : "prepared") {
  return { contract_version: SEMANTIC_VERSION, registration_id: registration, operation_id: new Headers(init.headers).get("X-Kastra-Operation-Id"),
    stage: body.stage, decision, status };
}
function held(body: any, init: RequestInit) {
  return { ...reply(body, init, "HOLD", "held"), checkpoint_id: checkpoint, hold: { decision: "HOLD", checkpoint_id: checkpoint,
    title: "Synthetic approval", on_timeout: "deny", server_now: new Date().toISOString(), expires_at: new Date(Date.now() + 10000).toISOString() } };
}
afterEach(() => vi.useRealTimers());

describe("registered OpenClaw semantic enforcement", () => {
  it("authorizes exact arguments, then dispatches the same operation before the durable local ALLOW", async () => {
    const f = fixture();
    expect(await f.handler(event)).toBeUndefined();
    expect(f.requests.map(r => r.body?.stage ?? "register")).toEqual(["register", "check", "dispatch"]);
    expect(f.requests[0].body.contract).toEqual(SEMANTIC_CONTRACT);
    expect(f.requests[1].body.arguments).toEqual(event.params);
    expect(f.requests[2].body.arguments).toBeUndefined();
    const operations = f.requests.slice(1).map(r => new Headers(r.init.headers).get("X-Kastra-Operation-Id"));
    expect(operations[0]).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
    expect(operations[1]).toEqual(operations[0]);
    expect(f.records).toMatchObject([{ decision: "ALLOW", status: "dispatched", operationId: operations[0], registrationId: registration }]);
    expect(f.requests.every(r => r.init.redirect === "error")).toBe(true);
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it("uses checkpoint approval only to resume, then reauthorizes dispatch without resending arguments", async () => {
    const f = fixture({ respond: (b, i) => b.stage === "check" ? ok(held(b, i), 202) : ok(reply(b, i)) });
    expect(await f.handler(event)).toBeUndefined();
    const stages = f.requests.filter(r => r.path.endsWith("check-event"));
    expect(stages.map(r => r.body.stage)).toEqual(["check", "resume", "dispatch"]);
    expect(new Set(stages.map(r => new Headers(r.init.headers).get("X-Kastra-Operation-Id"))).size).toBe(1);
    expect(stages.slice(1).every(r => r.body.arguments === undefined)).toBe(true);
    expect(f.records).toMatchObject([{ decision: "ALLOW", disposition: "hold_approved", checkpointId: checkpoint, status: "dispatched" }]);
  });
  it.each(["denied", "expired", "pending"])("never dispatches a %s checkpoint", async state => {
    const f = fixture({ state, respond: (b, i) => ok(held(b, i), 202) });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.filter(r => r.path.endsWith("check-event")).map(r => r.body.stage)).toEqual(["check"]);
    expect(f.records[0].decision).toBe("DENY");
  });
  it("blocks when current policy denies after human approval", async () => {
    const f = fixture({ respond: (b, i) => b.stage === "check" ? ok(held(b, i), 202) : ok(reply(b, i, "DENY", "denied"), 403) });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.some(r => r.body?.stage === "dispatch")).toBe(false);
    expect(f.records[0].decision).toBe("DENY");
  });
  it.each([
    ["unsupported host", { hostVersion: () => "2026.6.6" }, {}],
    ["missing host", { hostVersion: () => undefined }, {}],
    ["conflicting tool hook", { toolHookCount: () => 2 }, {}],
    ["missing registry", { toolHookCount: () => undefined }, {}],
    ["operator timeout below contract", { hookTimeoutMs: () => 10000 }, {}],
    ["fail-open configuration", {}, { failMode: "open" }],
    ["missing login even with fail open", {}, { deviceToken: "", failMode: "open" }],
  ] as const)("fails closed before network for %s", async (_, deps, config) => {
    const f = fixture({ deps, config });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests).toEqual([]); expect(f.legacy).not.toHaveBeenCalled();
  });
  it.each(["wrong-op", "wrong-registration", "wrong-stage", "403-allow", "200-deny", "legacy-prepared-allow", "prepared-allow", "released", "prepared-dispatch", "timeout-allow", "oversized-hold"])("rejects contradictory wire authority: %s", async fault => {
    const f = fixture({ respond: (b, i) => {
      const data: any = reply(b, i);
      if (fault === "wrong-op") data.operation_id = newOperationId();
      if (fault === "wrong-registration") data.registration_id = checkpoint;
      if (fault === "wrong-stage") data.stage = "complete";
      if (fault === "200-deny") data.decision = "DENY";
      if (fault === "legacy-prepared-allow" || fault === "prepared-allow") data.decision = "ALLOW";
      if (fault === "released") data.status = "released";
      if (fault === "prepared-dispatch") data.status = "prepared";
      if (fault === "timeout-allow" || fault === "oversized-hold") {
        const hold = held(b, i);
        if (fault === "timeout-allow") hold.hold.on_timeout = "allow";
        else hold.hold.expires_at = new Date(Date.now() + 600000).toISOString();
        return ok(hold, 202);
      }
      return ok(data, fault === "403-allow" ? 403 : fault === "legacy-prepared-allow" || fault === "200-deny" ? 200 : data.status === "prepared" ? 202 : 200);
    } });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.records[0]).toMatchObject({ decision: "DENY", disposition: "protocol_error" });
  });
  it.each(["contract_hash", "environment", "max_content_bytes"])("rejects altered registration %s before classification", async field => {
    const f = fixture({ registration: { [field]: field === "max_content_bytes" ? 999999 : "wrong" } });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests).toHaveLength(1);
  });
  it.each([401, 409, 429, 500, 503])("does not retry or dispatch on HTTP %s", async status => {
    const f = fixture({ respond: () => new Response("{}", { status }) });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.map(r => r.body?.stage ?? "register")).toEqual(["register", "check"]);
    expect(f.records[0].decision).toBe("DENY");
  });
  it("does not resend dispatch after an ambiguous response", async () => {
    const f = fixture({ respond: (b, i) => b.stage === "dispatch" ? Promise.reject(new TypeError("synthetic disconnect")) : ok(reply(b, i)) });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.map(r => r.body?.stage ?? "register")).toEqual(["register", "check", "dispatch"]);
    expect(f.records[0].operationId).toBeTruthy();
  });
  it("rechecks the live host hook registry before dispatch after a reload", async () => {
    let count = 1;
    const f = fixture({ deps: { toolHookCount: () => count }, respond: (b, i) => { count = 2; return ok(reply(b, i)); } });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.some(r => r.body?.stage === "dispatch")).toBe(false);
  });
  it("rejects oversized or lossy input before any registration and never clips", async () => {
    for (const params of [{ value: "é".repeat(33000) }, { get value() { throw new Error("not invoked"); } }, { n: Infinity }, { value: "\uD800" }, { "\uDC00": "key" }]) {
      const f = fixture();
      expect(await f.handler({ toolName: "exec", params })).toMatchObject({ block: true });
      expect(f.records[0].disposition).toBe("invalid_input"); expect(f.requests).toEqual([]);
    }
  });
  it("preserves well-formed Unicode argument content", async () => {
    const f = fixture();
    expect(await f.handler({ toolName: "exec", params: { text: "Safe 😀 É <>&" } })).toBeUndefined();
    expect(f.requests[1].body.arguments).toEqual({ text: "Safe 😀 É <>&" });
  });
  it("bounds streamed response bytes", async () => {
    let cancelled = false;
    const f = fixture({ respond: () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(700000)); }, cancel() { cancelled = true; },
    })) });
    expect(await f.handler(event)).toMatchObject({ block: true }); expect(cancelled).toBe(true);
  });
  it("aborts its own deadline and cannot dispatch a late prepared reply even when the transport ignores abort", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    let captured: { body: any; init: RequestInit } | undefined;
    const f = fixture({ respond: (body, init) => { captured = { body, init }; return new Promise(r => { resolve = r; }); } });
    const result = f.handler(event);
    await vi.advanceTimersByTimeAsync(599001);
    expect(await result).toMatchObject({ block: true });
    expect(captured?.init.signal?.aborted).toBe(true);
    resolve(ok(reply(captured!.body, captured!.init)));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests.some(r => r.body?.stage === "dispatch")).toBe(false);
    expect(f.records).toMatchObject([{ decision: "DENY", disposition: "hook_deadline" }]);
  });
  it("does not allow a tool if local outcome durability fails after dispatch authorization", async () => {
    const f = fixture({ deps: { recordOutcome: async () => { throw new Error("synthetic journal fault"); } } });
    expect(await f.handler(event)).toMatchObject({ block: true });
    expect(f.requests.at(-1)?.body.stage).toBe("dispatch");
  });
  it("does not register a semantic message_sending result gate", async () => {
    const f = fixture();
    expect(await createMessageSendingHandler(f.deps)({ content: "Synthetic", to: "local" })).toBeUndefined();
    expect(f.requests).toEqual([]);
  });
});
