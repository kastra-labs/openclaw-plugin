import { describe, expect, it } from "vitest";
import { KastraAuthError, KastraClient } from "./kastra-client.js";
import type { EvaluateRequest } from "./types.js";

const REQ: EvaluateRequest = { jurisdiction: "us", model: "openclaw", source: "openclaw" };

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (url: any, init: any) => {
    (fakeFetch as any).lastUrl = String(url);
    (fakeFetch as any).lastInit = init;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("KastraClient.evaluate", () => {
  it("sends auth + hold headers to /v1/evaluate", async () => {
    const f = fakeFetch(200, { success: true, data: { decision_id: "d1", decision: "ALLOW", reason: "no rule matched" } });
    const c = new KastraClient("https://demo.kastra.ai", "dh_x", f);
    await c.evaluate(REQ);
    expect((fakeFetch as any).lastUrl).toBe("https://demo.kastra.ai/v1/evaluate");
    const headers = (fakeFetch as any).lastInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer dh_x");
    expect(headers["accept-kastra-hold"]).toBe("1");
  });

  it("maps 200 ALLOW", async () => {
    const c = new KastraClient("https://x", "t", fakeFetch(200, { success: true, data: { decision_id: "d", decision: "ALLOW", reason: "ok" } }));
    expect(await c.evaluate(REQ)).toEqual({ kind: "allow", reason: "ok" });
  });

  it("maps DENY with rule id (also on 403)", async () => {
    const body = { success: true, data: { decision_id: "d", decision: "DENY", reason: "blocked", matched_rule: { id: "r1", jurisdiction: "us", model_prefix: "openclaw", reason: "blocked", priority: 1 } } };
    for (const status of [200, 403]) {
      const c = new KastraClient("https://x", "t", fakeFetch(status, body));
      expect(await c.evaluate(REQ)).toEqual({ kind: "deny", reason: "blocked", ruleId: "r1" });
    }
  });

  it("maps 202 to hold envelope", async () => {
    const env = { decision: "HOLD", checkpoint_id: "cp1", expires_at: "2026-06-12T12:00:00Z", on_timeout: "DENY", title: "Send email" };
    const c = new KastraClient("https://x", "t", fakeFetch(202, { success: true, data: env }));
    expect(await c.evaluate(REQ)).toEqual({ kind: "hold", envelope: env });
  });

  it("throws KastraAuthError on 401", async () => {
    const c = new KastraClient("https://x", "t", fakeFetch(401, { success: false, error: "unauthorized" }));
    await expect(c.evaluate(REQ)).rejects.toBeInstanceOf(KastraAuthError);
  });
});

describe("KastraClient.getCheckpoint", () => {
  it("decodes checkpoint state", async () => {
    const state = { id: "cp1", status: "approved", effective_decision: "ALLOW", title: "t", on_timeout: "DENY", expires_at: "2026-06-12T12:00:00Z" };
    const c = new KastraClient("https://x", "t", fakeFetch(200, { success: true, data: state }));
    expect(await c.getCheckpoint("cp1")).toEqual(state);
    expect((fakeFetch as any).lastUrl).toBe("https://x/v1/checkpoints/cp1");
  });
});
