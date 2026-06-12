import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBeforeToolCallHandler } from "./handler.js";
import type { Decision } from "./types.js";

// Real TOML so resolveConfig succeeds without plugin config.
const tomlPath = join(mkdtempSync(join(tmpdir(), "kastra-h-")), "config.toml");
writeFileSync(tomlPath, `device_handle = "dh_x"\ndefault_environment = "dev"\ndefault_jurisdiction = "us"\n`);

function handlerWith(decision: Decision | Error, extra: Parameters<typeof createBeforeToolCallHandler>[0] = {}) {
  const calls: any[] = [];
  const handler = createBeforeToolCallHandler({
    edgeConfigPath: tomlPath,
    log: () => {},
    notifyHold: async (n) => void calls.push(["notify", n]),
    clearHold: async (id) => void calls.push(["clear", id]),
    makeClient: () =>
      ({
        evaluate: async () => {
          if (decision instanceof Error) throw decision;
          return decision;
        },
        getCheckpoint: async () => ({ id: "cp1", status: "approved", effective_decision: "ALLOW", title: "t", on_timeout: "DENY", expires_at: new Date(Date.now() + 60_000).toISOString() }),
        heartbeat: async () => {},
        cancel: async () => {},
      }) as any,
    ...extra,
  });
  return { handler, calls };
}

const EVENT = { toolName: "exec", params: { command: "gog gmail send --to a@b.com" } };

describe("before_tool_call handler", () => {
  it("returns undefined on ALLOW", async () => {
    const { handler } = handlerWith({ kind: "allow" });
    expect(await handler(EVENT, {})).toBeUndefined();
  });

  it("blocks on DENY with the policy reason", async () => {
    const { handler } = handlerWith({ kind: "deny", reason: "email blocked", ruleId: "r1" });
    const got = await handler(EVENT, {});
    expect(got).toMatchObject({ block: true });
    expect(got!.blockReason).toContain("email blocked");
  });

  it("on HOLD: notifies daemon, waits, allows after approval, clears", async () => {
    const env = { decision: "HOLD", checkpoint_id: "cp1", expires_at: new Date(Date.now() + 60_000).toISOString(), on_timeout: "DENY" as const, title: "Send email" };
    const { handler, calls } = handlerWith({ kind: "hold", envelope: env });
    expect(await handler(EVENT, {})).toBeUndefined();
    expect(calls[0][0]).toBe("notify");
    expect(calls.at(-1)).toEqual(["clear", "cp1"]);
  });

  it("on HOLD denied: blocks with resolver context", async () => {
    const env = { decision: "HOLD", checkpoint_id: "cp1", expires_at: new Date(Date.now() + 60_000).toISOString(), on_timeout: "DENY" as const, title: "Send email" };
    const { handler } = handlerWith({ kind: "hold", envelope: env }, {
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          getCheckpoint: async () => ({ id: "cp1", status: "denied", effective_decision: "DENY", resolved_by: "f@e.st", title: "t", on_timeout: "DENY", expires_at: env.expires_at }),
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
    });
    const got = await handler(EVENT, {});
    expect(got).toMatchObject({ block: true });
    expect(got!.blockReason).toContain("f@e.st");
  });

  it("fail-open by default on evaluate errors", async () => {
    const { handler } = handlerWith(new Error("backend down"));
    expect(await handler(EVENT, {})).toBeUndefined();
  });

  it("fail-closed when configured", async () => {
    const { handler } = handlerWith(new Error("backend down"));
    const got = await handler({ ...EVENT, context: { pluginConfig: { deviceToken: "dh_x", failMode: "closed" } } } as any, {});
    expect(got).toMatchObject({ block: true });
  });

  it("unconfigured = ungoverned (never bricks the gateway)", async () => {
    const handler = createBeforeToolCallHandler({ edgeConfigPath: "/nonexistent/config.toml", log: () => {} });
    expect(await handler(EVENT, {})).toBeUndefined();
  });
});
