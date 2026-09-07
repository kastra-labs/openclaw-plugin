import { describe, expect, it, vi } from "vitest";
import { waitForCheckpoint } from "./hold.js";
import { KastraAuthError, KastraHttpError, KastraProtocolError } from "./kastra-client.js";
import type { CheckpointState, HoldEnvelope } from "./types.js";

const ENV: HoldEnvelope = {
  decision: "HOLD", checkpoint_id: "cp1", expires_at: new Date(600000).toISOString(), on_timeout: "DENY", title: "Review",
};
function fixture(states: Partial<CheckpointState>[] = [{ status: "pending" }]) {
  let time = 0; let count = 0;
  const heartbeats: number[] = [];
  const client = {
    getCheckpoint: vi.fn(async () => ({
      id: "cp1", status: "pending", title: "Review", on_timeout: "deny", expires_at: ENV.expires_at,
      ...states[Math.min(count++, states.length - 1)],
    } as CheckpointState)),
    heartbeat: vi.fn(async () => { heartbeats.push(time); }), cancel: vi.fn(async () => {}),
  };
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  return { client, clock, heartbeats };
}
describe("waitForCheckpoint", () => {
  it("keeps polling throttled to pollMs after a slow heartbeat", async () => {
    const f = fixture();
    const reads: number[] = [];
    const original = f.client.getCheckpoint.getMockImplementation()!;
    f.client.getCheckpoint.mockImplementation(async () => { reads.push(f.clock.now()); return original(); });
    f.client.heartbeat.mockImplementation(async () => { if (f.clock.now() > 0) await f.clock.sleep(4500); });
    await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000, heartbeatMs: 5000, pollMs: 5000 });
    const polls = reads.slice(0, -1); // the last read is the endgame read, deliberately unthrottled
    for (let i = 1; i < polls.length; i++) expect(polls[i] - polls[i - 1]).toBeGreaterThanOrEqual(5000);
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(f.clock.now()).toBeLessThanOrEqual(10000);
  });
  it.each([500, 1500])("honors an approval read that returns after the deadline (%s ms)", async latency => {
    const f = fixture([{ status: "pending" }, { status: "pending" }, { status: "approved", effective_decision: "ALLOW" }]);
    const original = f.client.getCheckpoint.getMockImplementation()!;
    let reads = 0;
    f.client.getCheckpoint.mockImplementation(async () => { await f.clock.sleep(++reads === 3 ? latency : 1000); return original(); });
    const result = await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000 });
    expect(result).toMatchObject({ decision: "ALLOW", disposition: "hold_approved" });
    expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it("records transient heartbeat failures on a subsequent approval", async () => {
    const f = fixture([{ status: "approved", effective_decision: "ALLOW" }]);
    f.client.heartbeat.mockRejectedValueOnce(new KastraHttpError(503));
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision: "ALLOW", heartbeatFailures: 1, heartbeatStatus: 503 });
  });
  it("keeps reading the checkpoint after an unrecoverable heartbeat rejection", async () => {
    const f = fixture([{ status: "approved", effective_decision: "ALLOW" }]);
    f.client.heartbeat.mockRejectedValue(new KastraAuthError());
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision: "ALLOW", disposition: "hold_approved", heartbeatFailures: 1, heartbeatStatus: 401 });
    expect(f.client.getCheckpoint).toHaveBeenCalled();
  });
  it("records a failed cancellation on the deadline path", async () => {
    const f = fixture();
    f.client.cancel.mockRejectedValue(new Error("Fixture cleanup failure"));
    expect(await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 5000 })).toMatchObject({ decision: "DENY", disposition: "hold_deadline", cancelFailed: true });
  });
  it("stops retrying a checkpoint that no longer exists", async () => {
    const f = fixture();
    f.client.getCheckpoint.mockRejectedValue(new KastraHttpError(404));
    expect(await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000 })).toMatchObject({ decision: "DENY", disposition: "hold_error" });
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["approved", "ALLOW"], ["denied", "DENY"], ["expired", "DENY"], ["cancelled", "DENY"], ["abandoned", "DENY"],
  ] as const)("returns a server-confirmed %s outcome", async (status, decision) => {
    const f = fixture([{ status, effective_decision: decision, resolved_by: "reviewer" }]);
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision, disposition: `hold_${status}`, resolvedBy: "reviewer" });
    expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it.each([["ALLOW", "ALLOW"], ["DENY", "DENY"]] as const)("applies on_timeout=%s locally once the review itself has expired", async (on_timeout, decision) => {
    const f = fixture();
    const env = { ...ENV, on_timeout, server_now: new Date(0).toISOString(), expires_at: new Date(5000).toISOString() };
    expect(await waitForCheckpoint(f.client, env, { ...f.clock, maxWaitMs: 20000 })).toMatchObject({ decision, disposition: "hold_deadline" });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.clock.now()).toBeLessThanOrEqual(20000);
  });
  it("denies rather than applying on_timeout=ALLOW when the host budget ends the wait early", async () => {
    const f = fixture();
    const env = { ...ENV, on_timeout: "ALLOW" as const, server_now: new Date(0).toISOString(), expires_at: new Date(600000).toISOString() };
    expect(await waitForCheckpoint(f.client, env, { ...f.clock, maxWaitMs: 10000 })).toMatchObject({ decision: "DENY", disposition: "hold_deadline" });
  });
  it("reads once and applies on_timeout when the envelope is already expired by the server clock", async () => {
    const f = fixture();
    const env = { ...ENV, expires_at: new Date(1000).toISOString(), server_now: new Date(9000).toISOString(), on_timeout: "ALLOW" as const };
    expect(await waitForCheckpoint(f.client, env, f.clock)).toMatchObject({ decision: "ALLOW", disposition: "hold_deadline" });
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(1);
    expect(f.client.heartbeat).not.toHaveBeenCalled();
  });
  it("prefers a terminal state over on_timeout on the post-deadline read", async () => {
    const f = fixture([{ status: "pending" }, { status: "denied", effective_decision: "DENY" }]);
    const env = { ...ENV, on_timeout: "ALLOW" as const };
    expect(await waitForCheckpoint(f.client, env, { ...f.clock, maxWaitMs: 6000, pollMs: 5000 }))
      .toMatchObject({ decision: "DENY", disposition: "hold_denied" });
  });
  it("heartbeats immediately and throughout a slow network wait", async () => {
    const f = fixture();
    const original = f.client.getCheckpoint.getMockImplementation()!;
    f.client.getCheckpoint.mockImplementation(async () => { await f.clock.sleep(3000); return original(); });
    await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 100000 });
    expect(f.heartbeats[0]).toBe(0);
    expect(f.heartbeats.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < f.heartbeats.length; i++) expect(f.heartbeats[i] - f.heartbeats[i - 1]).toBeLessThan(90000);
  });
  it("retries transient checkpoint reads but not protocol errors", async () => {
    const f = fixture([{ status: "approved", effective_decision: "ALLOW" }]);
    f.client.getCheckpoint.mockRejectedValueOnce(new Error("transient"));
    expect((await waitForCheckpoint(f.client, ENV, f.clock)).decision).toBe("ALLOW");
    f.client.getCheckpoint.mockRejectedValueOnce(new KastraProtocolError());
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision: "DENY", disposition: "hold_error" });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
  });
  it("uses server TTL rather than a skewed local expiry clock", async () => {
    const f = fixture([{ status: "pending" }, { status: "pending" }, { status: "approved", effective_decision: "ALLOW" }]);
    await f.clock.sleep(1000000);
    const env = { ...ENV, expires_at: new Date(1005000).toISOString(), server_now: new Date(945000).toISOString() };
    expect((await waitForCheckpoint(f.client, env, f.clock)).decision).toBe("ALLOW");
  });
  it("honors an approval that only lands on the post-deadline read", async () => {
    const f = fixture([{ status: "pending" }, { status: "pending" }, { status: "approved", effective_decision: "ALLOW" }]);
    const result = await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000, pollMs: 5000 });
    expect(result).toMatchObject({ decision: "ALLOW", disposition: "hold_approved" });
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(3);
  });
  it("aborts in-flight reads and stops heartbeat/poll activity after returning", async () => {
    const f = fixture(); const controller = new AbortController();
    let readSignal: AbortSignal | undefined;
    f.client.getCheckpoint.mockImplementation((async (_id: string, signal: AbortSignal) => {
      readSignal = signal; controller.abort(); return new Promise(() => {});
    }) as any);
    const result = await waitForCheckpoint(f.client, ENV, { signal: controller.signal });
    expect(result).toMatchObject({ decision: "DENY", disposition: "cancelled" });
    expect(readSignal?.aborted).toBe(true);
    const calls = f.client.getCheckpoint.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(calls);
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds a hung poll, endgame read, and cancellation rather than hanging the hook", async () => {
    const f = fixture();
    f.client.getCheckpoint.mockImplementation(() => new Promise(() => {}));
    f.client.cancel.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect((await waitForCheckpoint(f.client, ENV, { maxWaitMs: 20, cleanupMs: 10 })).decision).toBe("DENY");
    // Three bounded phases: the wait (20), the endgame read (10), the cancel (10).
    // The margin is for scheduling noise; an unbounded phase never returns at all.
    expect(Date.now() - started).toBeLessThan(500);
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(2);
  });
});
