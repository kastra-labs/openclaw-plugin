import { abortable, delay } from "./abort.js";
import { KastraAuthError, KastraHttpError, KastraProtocolError, type KastraClient } from "./kastra-client.js";
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
  heartbeatFailures?: number;
  heartbeatStatus?: number;
  cancelFailed?: boolean;
};

function permanentFailure(error: unknown): boolean {
  return error instanceof KastraAuthError || error instanceof KastraProtocolError ||
    (error instanceof KastraHttpError && error.status < 500 && error.status !== 408 && error.status !== 429);
}

function terminalResult(state: CheckpointState): HoldResult {
  const allow = (state.status === "approved" || state.status === "expired") && state.effective_decision === "ALLOW";
  return {
    decision: allow ? "ALLOW" : "DENY", disposition: `hold_${state.status}` as Disposition, status: state.status,
    decisionId: state.decision_id, ruleId: state.rule_id, resolvedBy: state.resolved_by, resolvedByEmail: state.resolved_by_email,
  };
}

export async function waitForCheckpoint(
  client: Pick<KastraClient, "getCheckpoint" | "heartbeat" | "cancel">,
  env: HoldEnvelope,
  opts: HoldWaitOpts = {},
): Promise<HoldResult> {
  const now = opts.now ?? Date.now;
  const maxWaitMs = opts.maxWaitMs ?? 540_000;
  const endgameMs = opts.cleanupMs ?? 1000;
  // Clock-skew correction: the deadline is the server's own TTL measured from
  // local receipt, so a machine whose clock is far off the server still waits
  // the interval the server intended. Without server_now there is nothing to
  // correct against, so the caller's budget is the only bound.
  const serverTTL = Date.parse(env.expires_at) - Date.parse(env.server_now ?? "");
  const expiredOnArrival = Number.isFinite(serverTTL) && serverTTL <= 0;
  const duration = Math.max(1, Number.isFinite(serverTTL) ? Math.min(maxWaitMs, serverTTL + 30_000) : maxWaitMs);
  const controller = new AbortController();
  const timer = expiredOnArrival ? undefined : setTimeout(() => controller.abort(), duration);
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const deadline = now() + duration;
  // When maxWaitMs clamps the wait below the checkpoint's own TTL, our deadline
  // is the host's hook budget and the review is still live. Without server_now
  // there is no proof of expiry at all, so treat it as never reached.
  const serverExpiresAt = now() + (Number.isFinite(serverTTL) ? serverTTL : Infinity);
  let lastHeartbeat = -Infinity;
  let terminal = false;
  let heartbeatFailures = 0;
  let heartbeatStatus: number | undefined;
  let result: HoldResult | undefined;
  const finish = (value: HoldResult): HoldResult => {
    result = { ...value, ...(heartbeatFailures ? { heartbeatFailures, heartbeatStatus } : {}) };
    return result;
  };
  // The deadline path: one last read on its own budget, because the backend
  // sweeper should have transitioned the row by now and a human approval that
  // landed during the wait must not be thrown away. Only when that read finds
  // no terminal state does the rule's on_timeout apply locally — the same
  // endgame the Claude Code and Codex clients run, so one rule means one thing
  // on every surface.
  const finalize = async (): Promise<HoldResult> => {
    const last = new AbortController();
    const lastTimer = setTimeout(() => last.abort(), endgameMs);
    try {
      const state = await abortable(client.getCheckpoint(env.checkpoint_id, last.signal), last.signal);
      if (state.status !== "pending") { terminal = true; return terminalResult(state); }
    } catch { /* Unreadable at the deadline: fall back to the rule's on_timeout. */ }
    finally { clearTimeout(lastTimer); last.abort(); }
    // on_timeout describes what happens when the REVIEW times out, never when
    // our own budget runs out first: a wait cut short by the host budget must
    // not fail open on a review a human is still able to answer.
    const reviewTimedOut = now() >= serverExpiresAt;
    return { decision: reviewTimedOut && env.on_timeout === "ALLOW" ? "ALLOW" : "DENY", disposition: "hold_deadline" };
  };
  try {
    // The envelope is already expired by the server's clock: no wait to run.
    if (expiredOnArrival) return finish(opts.signal?.aborted ? { decision: "DENY", disposition: "cancelled" } : await finalize());
    while (!signal.aborted && now() < deadline) {
      if (now() - lastHeartbeat >= (opts.heartbeatMs ?? 30_000)) {
        lastHeartbeat = now();
        // The heartbeat only defers the backend's abandonment sweep; it is
        // never authoritative over the read. A rejected heartbeat is recorded
        // and retried, so it can never discard an approval the GET would find.
        try { await abortable(client.heartbeat(env.checkpoint_id, signal), signal); }
        catch (error) {
          if (signal.aborted) break;
          heartbeatFailures++;
          heartbeatStatus = error instanceof KastraHttpError || error instanceof KastraAuthError ? error.status : undefined;
        }
      }
      if (signal.aborted || now() >= deadline) break;
      try {
        const state = await abortable(client.getCheckpoint(env.checkpoint_id, signal), signal);
        if (state.status !== "pending") { terminal = true; return finish(terminalResult(state)); }
      } catch (error) {
        if (permanentFailure(error)) return finish({ decision: "DENY", disposition: "hold_error" });
        // Network failures are retried, but cannot turn an unresolved HOLD into ALLOW.
      }
      if (signal.aborted || now() >= deadline) break;
      const sleepMs = Math.max(0, Math.min(opts.pollMs ?? 5_000, deadline - now()));
      try { await (opts.sleep ? abortable(opts.sleep(sleepMs), signal) : delay(sleepMs, signal)); }
      catch { if (signal.aborted) break; return finish({ decision: "DENY", disposition: "hold_error" }); }
    }
    if (opts.signal?.aborted) return finish({ decision: "DENY", disposition: "cancelled" });
    return finish(await finalize());
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!terminal) {
      // Cleanup has its own small budget: a caller's already-aborted signal
      // must not prevent cancellation from reaching the backend.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), endgameMs);
      try { await abortable(client.cancel(env.checkpoint_id, cleanup.signal), cleanup.signal); }
      catch { if (result) result.cancelFailed = true; }
      finally { clearTimeout(cleanupTimer); cleanup.abort(); }
    }
  }
}
