import { abortable, delay } from "./abort.js";
import { KastraAuthError, KastraProtocolError, type KastraClient } from "./kastra-client.js";
import type { Disposition } from "./outcomes.js";
import type { HoldEnvelope, CheckpointState } from "./types.js";

export type HoldWaitOpts = {
  pollMs?: number;
  heartbeatMs?: number;
  maxWaitMs?: number;
  cleanupMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};
export type HoldResult = {
  decision: "ALLOW" | "DENY";
  disposition: Disposition;
  status?: CheckpointState["status"];
  decisionId?: string;
  ruleId?: string;
  resolvedBy?: string;
  resolvedByEmail?: string;
};

export async function waitForCheckpoint(
  client: Pick<KastraClient, "getCheckpoint" | "heartbeat" | "cancel">,
  env: HoldEnvelope,
  opts: HoldWaitOpts = {},
): Promise<HoldResult> {
  const now = opts.now ?? Date.now;
  const maxWaitMs = opts.maxWaitMs ?? 540_000;
  const ttl = Date.parse(env.expires_at) - Date.parse(env.server_now ?? "");
  const duration = Math.max(1, Number.isFinite(ttl) ? Math.min(maxWaitMs, Math.max(0, ttl) + 30_000) : maxWaitMs);
  const deadline = now() + duration;
  const finalReadAt = deadline - Math.min(1000, duration * 0.1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration);
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  let lastHeartbeat = -Infinity;
  let terminal = false;
  try {
    while (!signal.aborted && now() < deadline) {
      const finalRead = now() >= finalReadAt;
      if (now() - lastHeartbeat >= (opts.heartbeatMs ?? 30_000)) {
        lastHeartbeat = now();
        try { await abortable(client.heartbeat(env.checkpoint_id, signal), signal); }
        catch { if (signal.aborted) break; }
      }
      try {
        const state = await abortable(client.getCheckpoint(env.checkpoint_id, signal), signal);
        if (signal.aborted || now() >= deadline) break;
        if (state.status !== "pending") {
          const allow = (state.status === "approved" || state.status === "expired") && state.effective_decision === "ALLOW";
          terminal = true;
          return {
            decision: allow ? "ALLOW" : "DENY", disposition: `hold_${state.status}` as Disposition, status: state.status,
            decisionId: state.decision_id, ruleId: state.rule_id, resolvedBy: state.resolved_by, resolvedByEmail: state.resolved_by_email,
          };
        }
      } catch (error) {
        if (error instanceof KastraAuthError || error instanceof KastraProtocolError) return { decision: "DENY", disposition: "hold_error" };
        // Network failures are retried, but cannot turn an unresolved HOLD into ALLOW.
      }
      if (finalRead || signal.aborted || now() >= deadline) break;
      const sleepMs = Math.max(0, Math.min(opts.pollMs ?? 5_000, finalReadAt - now()));
      try { await (opts.sleep ? abortable(opts.sleep(sleepMs), signal) : delay(sleepMs, signal)); }
      catch { if (signal.aborted) break; return { decision: "DENY", disposition: "hold_error" }; }
    }
    return { decision: "DENY", disposition: opts.signal?.aborted ? "cancelled" : "hold_deadline" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!terminal) {
      // Cleanup has its own small budget: a caller's already-aborted signal
      // must not prevent cancellation from reaching the backend.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), opts.cleanupMs ?? 1000);
      try { await abortable(client.cancel(env.checkpoint_id, cleanup.signal), cleanup.signal); }
      catch { /* Best effort; the action remains denied. */ }
      finally { clearTimeout(cleanupTimer); cleanup.abort(); }
    }
  }
}
