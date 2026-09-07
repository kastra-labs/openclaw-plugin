import { normalizeBaseUrl } from "./urls.js";
import type { CheckpointState, Decision, EvaluateRequest, HoldEnvelope } from "./types.js";

export class KastraAuthError extends Error {
  constructor(readonly status = 401) { super("Kastra device token rejected; re-run kastra-edge login or update deviceToken"); }
}
export class KastraProtocolError extends Error {
  constructor() { super("Invalid Kastra API response"); }
}
export class KastraHttpError extends Error {
  constructor(readonly status: number) { super("Kastra API unavailable"); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KastraProtocolError();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function optionalIdentifier(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!identifier(value)) throw new KastraProtocolError();
  return value;
}
function timeoutDecision(value: unknown): "ALLOW" | "DENY" {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  if (normalized !== "ALLOW" && normalized !== "DENY") throw new KastraProtocolError();
  return normalized;
}
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function envelope(value: unknown): Record<string, unknown> {
  const body = object(value);
  if (body.success !== true) throw new KastraProtocolError();
  return object(body.data);
}
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = object(await response.json());
    // A 403 can be an authentication failure or a complete policy DENY.
    // Never classify a decision-bearing envelope as a mere HTTP failure.
    if (response.status === 403 && body.success === false && body.data === undefined) throw new KastraAuthError(403);
    return envelope(body);
  }
  catch (error) {
    if (error instanceof SyntaxError) throw new KastraProtocolError();
    throw error;
  }
}
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function validateCheckpoint(value: unknown, id: string): CheckpointState {
  const state = object(value);
  const timeout = timeoutDecision(state.on_timeout);
  if (state.id !== id || !date(state.expires_at) || typeof state.title !== "string") throw new KastraProtocolError();
  const expected: Record<string, string | undefined> = {
    pending: undefined, approved: "ALLOW", denied: "DENY", expired: timeout, cancelled: "DENY", abandoned: "DENY",
  };
  if (typeof state.status !== "string" || !Object.hasOwn(expected, state.status) ||
      (state.status === "pending" ? state.effective_decision !== undefined && state.effective_decision !== "" :
        state.effective_decision !== expected[state.status])) throw new KastraProtocolError();
  for (const key of ["decision_id", "rule_id", "resolved_by"]) {
    if (Object.hasOwn(state, key)) state[key] = optionalIdentifier(state[key]);
  }
  if (state.resolved_by_email !== undefined && typeof state.resolved_by_email !== "string") throw new KastraProtocolError();
  return state as unknown as CheckpointState;
}

export class KastraClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly deviceToken: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async evaluate(req: EvaluateRequest, timeoutMs = 3000, signal?: AbortSignal): Promise<Decision> {
    const res = await this.fetchImpl(this.baseUrl + "/v1/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.deviceToken}`, "accept-kastra-hold": "1" },
      body: JSON.stringify(req), signal: requestSignal(timeoutMs, signal),
    });
    if (res.status === 401) throw new KastraAuthError();
    if (![200, 202, 403].includes(res.status)) {
      if (res.status >= 400) throw new KastraHttpError(res.status);
      throw new KastraProtocolError();
    }
    const data = await readEnvelope(res);
    if (res.status === 202) {
      const on_timeout = timeoutDecision(data.on_timeout);
      if (data.decision !== "HOLD" || !identifier(data.checkpoint_id) || !date(data.expires_at) ||
          typeof data.title !== "string" ||
          (data.server_now !== undefined && !date(data.server_now))) throw new KastraProtocolError();
      return { kind: "hold", envelope: { ...data, on_timeout } as HoldEnvelope };
    }
    if (!["ALLOW", "DENY"].includes(data.decision as string) ||
        typeof data.reason !== "string" || (res.status === 403 && data.decision !== "DENY")) throw new KastraProtocolError();
    let ruleId: string | undefined;
    if (data.matched_rule !== undefined && data.matched_rule !== null) {
      const rule = object(data.matched_rule);
      ruleId = optionalIdentifier(rule.id);
    }
    return { kind: data.decision === "ALLOW" ? "allow" : "deny", reason: data.reason, decisionId: optionalIdentifier(data.decision_id), ruleId };
  }

  async getCheckpoint(id: string, signal?: AbortSignal): Promise<CheckpointState> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/checkpoints/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.deviceToken}` }, signal: requestSignal(3000, signal),
    });
    if (res.status === 401 || res.status === 403) throw new KastraAuthError(res.status);
    if (res.status !== 200) throw new KastraHttpError(res.status);
    return validateCheckpoint(await readEnvelope(res), id);
  }

  async heartbeat(id: string, signal?: AbortSignal): Promise<void> { await this.postCheckpoint(id, "heartbeat", signal); }
  async cancel(id: string, signal?: AbortSignal): Promise<void> { await this.postCheckpoint(id, "cancel", signal); }

  private async postCheckpoint(id: string, action: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/checkpoints/${encodeURIComponent(id)}/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${this.deviceToken}` }, signal: requestSignal(1000, signal),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new KastraAuthError(response.status);
    if (!response.ok) throw new KastraHttpError(response.status);
  }
}
