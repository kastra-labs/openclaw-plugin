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
  it("recomputes the final-read boundary after a slow heartbeat", async () => {
    const f = fixture();
    const reads: number[] = [];
    const original = f.client.getCheckpoint.getMockImplementation()!;
    f.client.getCheckpoint.mockImplementation(async () => { reads.push(f.clock.now()); return original(); });
    f.client.heartbeat.mockImplementation(async () => { if (f.clock.now() > 0) await f.clock.sleep(4500); });
    await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000, heartbeatMs: 5000 });
    expect(reads).toEqual([0, 9500]);
  });
  it.each([500, 1500])("bounds a final approval read taking %s ms", async latency => {
    const f = fixture([{ status: "pending" }, { status: "pending" }, { status: "approved", effective_decision: "ALLOW" }]);
    const original = f.client.getCheckpoint.getMockImplementation()!;
    let reads = 0;
    f.client.getCheckpoint.mockImplementation(async () => { await f.clock.sleep(++reads === 3 ? latency : 1000); return original(); });
    const result = await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000 });
    expect(result).toMatchObject(latency === 500 ? { decision: "ALLOW", disposition: "hold_approved" } : { decision: "DENY", disposition: "hold_deadline" });
    expect(reads).toBe(3);
    expect(f.client.cancel).toHaveBeenCalledTimes(latency === 500 ? 0 : 1);
  });
  it("records transient heartbeat failures on a subsequent approval", async () => {
    const f = fixture([{ status: "approved", effective_decision: "ALLOW" }]);
    f.client.heartbeat.mockRejectedValueOnce(new KastraHttpError(503));
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision: "ALLOW", heartbeatFailures: 1, heartbeatStatus: 503 });
  });
  it("stops on heartbeat authentication rejection and records failed cancellation", async () => {
    const f = fixture([{ status: "approved", effective_decision: "ALLOW" }]);
    f.client.heartbeat.mockRejectedValue(new KastraAuthError());
    f.client.cancel.mockRejectedValue(new Error("Fixture cleanup failure"));
    expect(await waitForCheckpoint(f.client, ENV, f.clock)).toMatchObject({ decision: "DENY", disposition: "hold_error", heartbeatFailures: 1, heartbeatStatus: 401, cancelFailed: true });
    expect(f.client.getCheckpoint).not.toHaveBeenCalled();
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
  it.each(["ALLOW", "DENY"] as const)("denies unresolved local deadlines even with on_timeout=%s", async (on_timeout) => {
    const f = fixture();
    expect(await waitForCheckpoint(f.client, { ...ENV, on_timeout }, { ...f.clock, maxWaitMs: 20000 })).toMatchObject({ decision: "DENY", disposition: "hold_deadline" });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.clock.now()).toBeLessThanOrEqual(20000);
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
  it("reserves a final read before the hard deadline and honors a late approval", async () => {
    const f = fixture([{ status: "pending" }, { status: "pending" }, { status: "approved", effective_decision: "ALLOW" }]);
    const result = await waitForCheckpoint(f.client, ENV, { ...f.clock, maxWaitMs: 10000, pollMs: 5000 });
    expect(result.decision).toBe("ALLOW");
    expect(f.client.getCheckpoint).toHaveBeenCalledTimes(3);
    expect(f.clock.now()).toBeLessThan(10000);
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
  it("bounds a hung checkpoint and hung cancellation within the cleanup allowance", async () => {
    const f = fixture();
    f.client.getCheckpoint.mockImplementation(() => new Promise(() => {}));
    f.client.cancel.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect((await waitForCheckpoint(f.client, ENV, { maxWaitMs: 20, cleanupMs: 10 })).decision).toBe("DENY");
    expect(Date.now() - started).toBeLessThan(100);
  });
});
