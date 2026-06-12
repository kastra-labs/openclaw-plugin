import { describe, expect, it } from "vitest";
import { waitForCheckpoint } from "./hold.js";
import type { CheckpointState, HoldEnvelope } from "./types.js";

const ENV: HoldEnvelope = {
  decision: "HOLD",
  checkpoint_id: "cp1",
  expires_at: new Date(600_000).toISOString(), // expires at t=600s
  on_timeout: "DENY",
  title: "Send email",
};

// Fake client: returns queued states, then repeats the last one.
function fakeClient(states: Array<Partial<CheckpointState>>) {
  const heartbeats: number[] = [];
  const cancels: number[] = [];
  let i = 0;
  let t = 0;
  const client = {
    getCheckpoint: async () => {
      const s = states[Math.min(i++, states.length - 1)];
      return { id: "cp1", status: "pending", title: "t", on_timeout: "DENY", expires_at: ENV.expires_at, ...s } as CheckpointState;
    },
    heartbeat: async () => {
      heartbeats.push(t);
    },
    cancel: async () => {
      cancels.push(t);
    },
  };
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  return { client: client as any, clock, heartbeats, cancels };
}

describe("waitForCheckpoint", () => {
  it("returns ALLOW when approved", async () => {
    const { client, clock } = fakeClient([{ status: "pending" }, { status: "approved", effective_decision: "ALLOW", resolved_by: "f@e.st" }]);
    const got = await waitForCheckpoint(client, ENV, { ...clock });
    expect(got).toEqual({ decision: "ALLOW", resolvedBy: "f@e.st" });
  });

  it("returns DENY when denied", async () => {
    const { client, clock } = fakeClient([{ status: "denied", effective_decision: "DENY" }]);
    const got = await waitForCheckpoint(client, ENV, { ...clock });
    expect(got.decision).toBe("DENY");
  });

  it("applies on_timeout at the deadline", async () => {
    const { client, clock } = fakeClient([{ status: "pending" }]);
    const got = await waitForCheckpoint(client, ENV, { ...clock, maxWaitMs: 20_000, pollMs: 5_000 });
    expect(got.decision).toBe("DENY"); // ENV.on_timeout
  });

  it("respects on_timeout ALLOW", async () => {
    const { client, clock } = fakeClient([{ status: "pending" }]);
    const got = await waitForCheckpoint(client, { ...ENV, on_timeout: "ALLOW" }, { ...clock, maxWaitMs: 20_000, pollMs: 5_000 });
    expect(got.decision).toBe("ALLOW");
  });

  it("heartbeats immediately and ~every heartbeatMs", async () => {
    const { client, clock, heartbeats } = fakeClient([{ status: "pending" }]);
    await waitForCheckpoint(client, ENV, { ...clock, maxWaitMs: 70_000, pollMs: 5_000, heartbeatMs: 30_000 });
    expect(heartbeats[0]).toBe(0);
    expect(heartbeats.length).toBeGreaterThanOrEqual(3); // t=0, ~30s, ~60s
  });

  it("tolerates transient checkpoint fetch errors", async () => {
    let calls = 0;
    const client = {
      getCheckpoint: async () => {
        if (calls++ < 2) throw new Error("network blip");
        return { id: "cp1", status: "approved", effective_decision: "ALLOW", title: "t", on_timeout: "DENY", expires_at: ENV.expires_at } as CheckpointState;
      },
      heartbeat: async () => {},
      cancel: async () => {},
    };
    let t = 0;
    const got = await waitForCheckpoint(client as any, ENV, { now: () => t, sleep: async (ms) => void (t += ms) });
    expect(got.decision).toBe("ALLOW");
  });

  // ── Fix 1: server_now clock-skew correction ──────────────────────────────
  //
  // Scenario: the client's local clock reads t=1_000_000ms. The server
  // issued an envelope with:
  //   expires_at  = 1_005_000ms (absolute)  — only 5s from server's current wall time
  //   server_now  = 945_000ms               — server's wall time when issuing
  //
  // server-intended TTL = 1_005_000 − 945_000 = 60_000ms (60 s).
  //
  // OLD code: deadline = min(1_000_000 + 540_000, Date.parse(expires_at))
  //                    = min(1_540_000, 1_005_000) = 1_005_000.
  //   With pollMs=5_000, first poll at t=1_000_000 → pending, sleep → t=1_005_000,
  //   second loop: poll → pending, deadline check: 1_005_000 >= 1_005_000 → DENY.
  //
  // NEW code (skew-corrected): TTL = 60_000ms. deadline = 1_000_000 + min(540_000, 60_000+30_000)
  //                                             = 1_000_000 + 90_000 = 1_090_000.
  //   First poll → pending, sleep → t=1_005_000, second poll → approved → ALLOW. ✓
  it("server_now skew correction — uses server TTL not raw expires_at (Fix 1)", async () => {
    // Clock starts at t=1_000_000 so that Date.parse(expires_at)=1_005_000 is "5s in the future"
    // but the server-intended TTL is 60s.
    const expiresAtMs = 1_005_000;
    const serverNowMs = 945_000; // TTL = 60_000
    const env: HoldEnvelope = {
      decision: "HOLD",
      checkpoint_id: "cp1",
      expires_at: new Date(expiresAtMs).toISOString(),
      server_now: new Date(serverNowMs).toISOString(),
      on_timeout: "DENY",
      title: "skew-test",
    };

    let t = 1_000_000; // local clock — 5s "ahead" of expires_at
    const states: Array<Partial<CheckpointState>> = [
      { status: "pending" },
      { status: "approved", effective_decision: "ALLOW", resolved_by: "reviewer@x" },
    ];
    let i = 0;
    const client = {
      getCheckpoint: async () => {
        const s = states[Math.min(i++, states.length - 1)];
        return { id: "cp1", status: "pending", title: "t", on_timeout: "DENY", expires_at: env.expires_at, ...s } as CheckpointState;
      },
      heartbeat: async () => {},
      cancel: async () => {},
    };

    const got = await waitForCheckpoint(client as any, env, {
      now: () => t,
      sleep: async (ms) => void (t += ms),
      pollMs: 5_000,
    });

    // Old code would have timed out (DENY) because expires_at is only 5s after
    // local clock start. New code sees 60s TTL + 30s slack = 90s → waits for the
    // second poll which returns approved ALLOW.
    expect(got.decision).toBe("ALLOW");
    expect(got.resolvedBy).toBe("reviewer@x");
  });

  // ── Fix 2: last-chance read at the deadline ───────────────────────────────
  //
  // The approval is only reachable via the deadline-path getCheckpoint call:
  //   call 0 (loop body, t=0):   pending → not terminal → deadline 0<10_000 → sleep → t=5_000
  //   call 1 (loop body, t=5_000): pending → deadline 5_000<10_000 → sleep → t=10_000
  //   call 2 (loop body, t=10_000): pending → deadline: 10_000>=10_000 → last-chance read
  //   call 3 (last-chance read):  approved ALLOW → returned
  //
  // Without Fix 2 the code falls straight to on_timeout DENY after call 2.
  it("last-chance read at deadline honors approval instead of falling to on_timeout (Fix 2)", async () => {
    let callCount = 0;
    const stateMap: Record<number, Partial<CheckpointState>> = {
      0: { status: "pending" },
      1: { status: "pending" },
      2: { status: "pending" },
      3: { status: "approved", effective_decision: "ALLOW", resolved_by: "last-chance@x" },
    };
    let t = 0;
    const client = {
      getCheckpoint: async () => {
        const idx = Math.min(callCount++, 3);
        const s = stateMap[idx] ?? { status: "pending" };
        return { id: "cp1", status: "pending", title: "t", on_timeout: "DENY", expires_at: ENV.expires_at, ...s } as CheckpointState;
      },
      heartbeat: async () => {},
      cancel: async () => {},
    };

    const env: HoldEnvelope = { ...ENV, on_timeout: "DENY" };
    const got = await waitForCheckpoint(client as any, env, {
      now: () => t,
      sleep: async (ms) => void (t += ms),
      maxWaitMs: 10_000,
      pollMs: 5_000,
    });

    expect(got.decision).toBe("ALLOW");
    expect(got.resolvedBy).toBe("last-chance@x");
    expect(callCount).toBe(4); // 3 loop calls + 1 last-chance read
  });

  // ── Fix 3: AbortSignal cancellation ──────────────────────────────────────
  //
  // After the first sleep the signal is aborted; the post-sleep abort check
  // fires, cancel() is called, and the function returns on_timeout immediately.
  it("abort signal returns on_timeout and calls cancel (Fix 3)", async () => {
    const controller = new AbortController();
    const { client, clock, cancels } = fakeClient([{ status: "pending" }]);

    // Override sleep to also abort after advancing the clock.
    let t = 0;
    const sleepAndAbort = async (ms: number) => {
      t += ms;
      controller.abort();
    };

    const got = await waitForCheckpoint(client, ENV, {
      now: () => t,
      sleep: sleepAndAbort,
      pollMs: 5_000,
      maxWaitMs: 540_000,
      signal: controller.signal,
    });

    expect(got.decision).toBe("DENY"); // on_timeout = DENY
    expect(cancels.length).toBeGreaterThanOrEqual(1);
  });

  // ── Fix 4 / heartbeat cadence under slow network ─────────────────────────
  //
  // getCheckpoint advances fake time by 3_000ms per call (simulating a 3s
  // network round-trip). Assert that heartbeat gaps in fake-clock time
  // never exceed 90_000ms (the backend's stale-heartbeat threshold).
  it("heartbeat gaps stay < 90_000ms even when getCheckpoint takes 3_000ms (Fix 4)", async () => {
    let t = 0;
    const heartbeatTimestamps: number[] = [];

    // 20 pending states then resolve; each getCheckpoint advances clock 3_000ms.
    const pendingCount = 20;
    let callCount = 0;
    const client = {
      getCheckpoint: async () => {
        t += 3_000;
        callCount++;
        if (callCount > pendingCount) {
          return { id: "cp1", status: "approved", effective_decision: "ALLOW", title: "t", on_timeout: "DENY", expires_at: ENV.expires_at } as CheckpointState;
        }
        return { id: "cp1", status: "pending", title: "t", on_timeout: "DENY", expires_at: ENV.expires_at } as CheckpointState;
      },
      heartbeat: async () => {
        heartbeatTimestamps.push(t);
      },
      cancel: async () => {},
    };

    const got = await waitForCheckpoint(client as any, ENV, {
      now: () => t,
      sleep: async (ms) => void (t += ms),
      pollMs: 5_000,
      heartbeatMs: 30_000,
      maxWaitMs: 540_000,
    });

    expect(got.decision).toBe("ALLOW");
    // Check that no gap between consecutive heartbeats exceeds 90_000ms.
    for (let j = 1; j < heartbeatTimestamps.length; j++) {
      const gap = heartbeatTimestamps[j] - heartbeatTimestamps[j - 1];
      expect(gap).toBeLessThan(90_000);
    }
  });
});
