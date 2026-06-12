import type { KastraClient } from "./kastra-client.js";
import type { HoldEnvelope } from "./types.js";

export type HoldWaitOpts = {
  pollMs?: number; //      default 5 000 — mirrors kastra-edge polling safety net
  heartbeatMs?: number; // default 30 000 — backend abandons after ~90 s silence
  maxWaitMs?: number; //   default 540 000 — MUST stay under OpenClaw's 600 s hook budget
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export type HoldResult = { decision: "ALLOW" | "DENY"; resolvedBy?: string };

// Blocks until the checkpoint is resolved in the Kastra console/popover,
// expires, or our own deadline passes. The deadline exists because an
// OpenClaw hook aborted by the runner produces NO decision (= fail-open);
// we must return the rule's on_timeout decision before that can happen.
export async function waitForCheckpoint(
  client: Pick<KastraClient, "getCheckpoint" | "heartbeat" | "cancel">,
  env: HoldEnvelope,
  opts: HoldWaitOpts = {},
): Promise<HoldResult> {
  const pollMs = opts.pollMs ?? 5_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const maxWaitMs = opts.maxWaitMs ?? 540_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = opts.signal;

  const started = now();

  // Clock-skew-corrected deadline (mirrors wait.go lines 131–138).
  // Use server-intended TTL (ExpiresAt − ServerNow) anchored to local receipt
  // time so a client whose clock is wildly off still gets a deadline that
  // matches the server's intended TTL.
  const expiresAt = Date.parse(env.expires_at);
  const serverNow = env.server_now ? Date.parse(env.server_now) : NaN;
  // Server-intended TTL, immune to local clock skew. Falls back to maxWaitMs
  // when the envelope lacks a usable server_now/expires_at pair.
  const ttl = Number.isFinite(expiresAt) && Number.isFinite(serverNow) ? expiresAt - serverNow : NaN;
  // +30s anti-race slack vs the server-side sweeper (mirrors Go wait.go:138),
  // but the OpenClaw hook budget (maxWaitMs) always remains the hard cap.
  const deadline =
    started +
    (Number.isFinite(ttl) ? Math.min(maxWaitMs, Math.max(0, ttl) + 30_000) : maxWaitMs);

  void client.heartbeat(env.checkpoint_id).catch(() => {});
  let lastHeartbeat = started;

  for (;;) {
    // Check abort signal at top of each iteration.
    if (signal?.aborted) {
      void client.cancel?.(env.checkpoint_id);
      return { decision: env.on_timeout === "ALLOW" ? "ALLOW" : "DENY" };
    }

    try {
      const state = await client.getCheckpoint(env.checkpoint_id);
      if (state.status !== "pending") {
        return {
          decision: state.effective_decision === "ALLOW" ? "ALLOW" : "DENY",
          resolvedBy: state.resolved_by,
        };
      }
    } catch {
      // transient — keep polling until the deadline
    }

    if (now() >= deadline) {
      // Last-chance read (mirrors Go's finalize() at wait.go:223–233):
      // the server-side sweeper should have transitioned the checkpoint to
      // "expired" with the rule's on_timeout policy applied. If somehow still
      // pending, fall back to the envelope's on_timeout locally.
      try {
        const s = await client.getCheckpoint(env.checkpoint_id);
        if (s.status !== "pending") {
          return { decision: s.effective_decision === "ALLOW" ? "ALLOW" : "DENY", resolvedBy: s.resolved_by };
        }
      } catch {
        /* fall through to on_timeout */
      }
      return { decision: env.on_timeout === "ALLOW" ? "ALLOW" : "DENY" };
    }

    if (now() - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now();
      void client.heartbeat(env.checkpoint_id).catch(() => {});
    }

    await sleep(pollMs);

    // Check abort signal after sleep too.
    if (signal?.aborted) {
      void client.cancel?.(env.checkpoint_id);
      return { decision: env.on_timeout === "ALLOW" ? "ALLOW" : "DENY" };
    }
  }
}
