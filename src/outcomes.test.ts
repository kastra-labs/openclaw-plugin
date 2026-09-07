import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutcomeRecorder } from "./outcomes.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "kastra-outcomes-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("durable outcome journal", () => {
  it("appends correlated records privately without accepting raw input or credentials", async () => {
    const path = join(fixture(), "audit", "outcomes.jsonl");
    const record = createOutcomeRecorder({ path });
    await record({ hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow", toolCallId: "c", decisionId: "d", token: "secret", input: "secret" } as any);
    await record({ hook: "before_tool_call", decision: "ALLOW", disposition: "evaluate_error" });
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ version: 1, toolCallId: "c", decisionId: "d", disposition: "policy_allow" });
    expect(records[0].id).not.toBe(records[1].id);
    expect(readFileSync(path, "utf8")).not.toContain("secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("rotates within bounded retention", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    const record = createOutcomeRecorder({ path, maxBytes: 1, archives: 2 });
    for (let i = 0; i < 5; i++) await record({ hook: "before_tool_call", decision: "DENY", disposition: "policy_deny", toolCallId: String(i) });
    expect(JSON.parse(readFileSync(path, "utf8")).toolCallId).toBe("4");
    expect(JSON.parse(readFileSync(path + ".2", "utf8")).toolCallId).toBe("2");
    expect(() => statSync(path + ".3")).toThrow();
  });
  it("refuses to append through a symlink", async () => {
    const dir = fixture();
    const path = join(dir, "outcomes.jsonl");
    symlinkSync(join(dir, "target"), path);
    await expect(Promise.resolve().then(() => createOutcomeRecorder({ path })({ hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow" }))).rejects.toThrow();
  });
  const outcome = { hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow" } as const;
  it("does not write an already-cancelled authorization", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    await expect(createOutcomeRecorder({ path })(outcome, AbortSignal.abort())).rejects.toThrow();
    expect(() => statSync(path)).toThrow();
  });
  it("reclaims a stale non-directory lock instead of blocking every later outcome", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    writeFileSync(path + ".lock", "");
    utimesSync(path + ".lock", new Date(0), new Date(0));
    await Promise.resolve().then(() => createOutcomeRecorder({ path })(outcome));
    expect(JSON.parse(readFileSync(path, "utf8")).decision).toBe("ALLOW");
    // A second outcome must not depend on the first having cleaned up by luck.
    await Promise.resolve().then(() => createOutcomeRecorder({ path })(outcome));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });
  it("refuses a fresh non-directory lock rather than racing an unknown writer", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    writeFileSync(path + ".lock", "");
    await expect(createOutcomeRecorder({ path, timeoutMs: 60 })(outcome)).rejects.toThrow();
    expect(statSync(path + ".lock").isFile()).toBe(true);
  });
  it("performs filesystem work asynchronously", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    const pending = createOutcomeRecorder({ path })(outcome);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });
  it("retries brief contention without losing or rejecting invocations", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    mkdirSync(path + ".lock");
    const timer = setTimeout(() => rmSync(path + ".lock", { recursive: true }), 50);
    try {
      await Promise.resolve().then(() => createOutcomeRecorder({ path })(outcome));
      expect(JSON.parse(readFileSync(path, "utf8")).decision).toBe("ALLOW");
    } finally { clearTimeout(timer); }
  });
  it("recovers an abandoned lock and an interrupted final line", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    writeFileSync(path, '{"id":"previous"}\n{"partial":');
    mkdirSync(path + ".lock");
    utimesSync(path + ".lock", new Date(0), new Date(0));
    await Promise.resolve().then(() => createOutcomeRecorder({ path })(outcome));
    const records = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("previous");
    expect(records[1].disposition).toBe("policy_allow");
  });
  it("bounds waiting without stealing a live lock", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    mkdirSync(path + ".lock");
    const started = Date.now();
    await expect(Promise.resolve().then(() => createOutcomeRecorder({ path, timeoutMs: 60 } as any)(outcome))).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(300);
    expect(statSync(path + ".lock").isDirectory()).toBe(true);
  });
  it("serializes concurrent append and rotation across recorder instances", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    const recorders = Array.from({ length: 5 }, () => createOutcomeRecorder({ path, maxBytes: 1000, archives: 20 }));
    await Promise.all(Array.from({ length: 25 }, (_, i) => recorders[i % recorders.length]({ ...outcome, toolCallId: String(i) })));
    const records = Array.from({ length: 21 }, (_, i) => {
      try { return readFileSync(path + (i ? `.${i}` : ""), "utf8").trim().split("\n").map(JSON.parse); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }).flat();
    expect(records).toHaveLength(25);
    expect(new Set(records.map(record => record.toolCallId)).size).toBe(25);
  });
  it("retains safe heartbeat and cancellation diagnostics", async () => {
    const path = join(fixture(), "outcomes.jsonl");
    await createOutcomeRecorder({ path })({ ...outcome, heartbeatFailures: 2, heartbeatStatus: 503, cancelFailed: true } as any);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ heartbeatFailures: 2, heartbeatStatus: 503, cancelFailed: true });
  });
});
