import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutcomeRecorder } from "./outcomes.js";

const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "kastra-outcomes-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("durable outcome journal", () => {
  it("appends correlated records privately without accepting raw input or credentials", () => {
    const path = join(fixture(), "audit", "outcomes.jsonl");
    const record = createOutcomeRecorder({ path });
    record({ hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow", toolCallId: "c", decisionId: "d", token: "secret", input: "secret" } as any);
    record({ hook: "before_tool_call", decision: "ALLOW", disposition: "evaluate_error" });
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ version: 1, toolCallId: "c", decisionId: "d", disposition: "policy_allow" });
    expect(records[0].id).not.toBe(records[1].id);
    expect(readFileSync(path, "utf8")).not.toContain("secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("rotates within bounded retention", () => {
    const path = join(fixture(), "outcomes.jsonl");
    const record = createOutcomeRecorder({ path, maxBytes: 1, archives: 2 });
    for (let i = 0; i < 5; i++) record({ hook: "before_tool_call", decision: "DENY", disposition: "policy_deny", toolCallId: String(i) });
    expect(JSON.parse(readFileSync(path, "utf8")).toolCallId).toBe("4");
    expect(JSON.parse(readFileSync(path + ".2", "utf8")).toolCallId).toBe("2");
    expect(() => statSync(path + ".3")).toThrow();
  });
  it("refuses to append through a symlink", () => {
    const dir = fixture();
    const path = join(dir, "outcomes.jsonl");
    symlinkSync(join(dir, "target"), path);
    expect(() => createOutcomeRecorder({ path })({ hook: "before_tool_call", decision: "ALLOW", disposition: "policy_allow" })).toThrow();
  });
});
