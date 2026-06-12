import type { KastraClient } from "./kastra-client.js";
import type { HoldEnvelope } from "./types.js";

export type HoldWaitOpts = {
  pollMs?: number; //      default 5 000 — mirrors kastra-edge polling safety net
  heartbeatMs?: number; // default 30 000 — backend abandons after ~90 s silence
  maxWaitMs?: number; //   default 540 000 — MUST stay under OpenClaw's 600 s hook budget
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type HoldResult = { decision: "ALLOW" | "DENY"; resolvedBy?: string };

// Blocks until the checkpoint is resolved in the Kastra console/popover,
// expires, or our own deadline passes. The deadline exists because an
// OpenClaw hook aborted by the runner produces NO decision (= fail-open);
// we must return the rule's on_timeout decision before that can happen.
export async function waitForCheckpoint(
  client: Pick<KastraClient, "getCheckpoint" | "heartbeat">,
  env: HoldEnvelope,
  opts: HoldWaitOpts = {},
): Promise<HoldResult> {
  const pollMs = opts.pollMs ?? 5_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const maxWaitMs = opts.maxWaitMs ?? 540_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const started = now();
  const expiresAt = Date.parse(env.expires_at);
  const deadline = Math.min(started + maxWaitMs, Number.isFinite(expiresAt) ? expiresAt : started + maxWaitMs);

  void client.heartbeat(env.checkpoint_id);
  let lastHeartbeat = started;

  for (;;) {
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
      return { decision: env.on_timeout === "ALLOW" ? "ALLOW" : "DENY" };
    }
    if (now() - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now();
      void client.heartbeat(env.checkpoint_id);
    }
    await sleep(pollMs);
  }
}
