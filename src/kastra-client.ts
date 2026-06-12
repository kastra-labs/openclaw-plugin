import type {
  ApiEnvelope,
  CheckpointState,
  Decision,
  EvaluateRequest,
  ExecuteResponse,
  HoldEnvelope,
} from "./types.js";

export class KastraAuthError extends Error {
  constructor() {
    super("Kastra device token rejected (401) — re-run `kastra-edge login` or update deviceToken");
  }
}

// Mirrors kastra-edge/internal/client/evaluate.go: Bearer device handle,
// Accept-Kastra-Hold opt-in, 3s evaluate timeout.
export class KastraClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly deviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async evaluate(req: EvaluateRequest, timeoutMs = 3000): Promise<Decision> {
    const res = await this.fetchImpl(this.baseUrl + "/v1/evaluate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.deviceToken}`,
        "accept-kastra-hold": "1",
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) throw new KastraAuthError();
    if (res.status === 202) {
      const body = (await res.json()) as ApiEnvelope<HoldEnvelope>;
      if (!body.data?.checkpoint_id) throw new Error("202 hold response without checkpoint envelope");
      return { kind: "hold", envelope: body.data };
    }
    // 200 carries ALLOW/DENY; 403 carries a full DENY envelope too.
    if (!res.ok && res.status !== 403) throw new Error(`/v1/evaluate upstream error (${res.status})`);
    const body = (await res.json()) as ApiEnvelope<ExecuteResponse>;
    const data = body.data;
    if (!data?.decision) {
      throw new Error(`unexpected /v1/evaluate response (${res.status}): ${body.error ?? "no decision"}`);
    }
    if (data.decision === "DENY") {
      return { kind: "deny", reason: data.reason, ruleId: data.matched_rule?.id };
    }
    return { kind: "allow", reason: data.reason };
  }

  async getCheckpoint(id: string): Promise<CheckpointState> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/checkpoints/${id}`, {
      headers: { authorization: `Bearer ${this.deviceToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`checkpoint fetch failed (${res.status})`);
    const body = (await res.json()) as ApiEnvelope<CheckpointState>;
    if (!body.data) throw new Error(`checkpoint fetch failed (${res.status}): missing data`);
    return body.data;
  }

  // Best-effort: heartbeat failures must never break the wait loop.
  async heartbeat(id: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/v1/checkpoints/${id}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.deviceToken}` },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* ignore */
    }
  }
}
