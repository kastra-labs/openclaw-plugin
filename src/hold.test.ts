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
  };
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  return { client: client as any, clock, heartbeats };
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
    };
    let t = 0;
    const got = await waitForCheckpoint(client as any, ENV, { now: () => t, sleep: async (ms) => void (t += ms) });
    expect(got.decision).toBe("ALLOW");
  });
});
