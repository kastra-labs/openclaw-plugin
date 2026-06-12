import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";
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

  // --- Fix 1: apiPluginConfig fallback ---
  it("apiPluginConfig fallback: uses api.pluginConfig when no edge config or event pluginConfig", async () => {
    // No edge config file; makeClient throws to exercise failMode from api config.
    const handler = createBeforeToolCallHandler({
      edgeConfigPath: "/nonexistent/config.toml",
      log: () => {},
      apiPluginConfig: () => ({ deviceToken: "dh_api", failMode: "closed" }),
      makeClient: () => {
        throw new Error("backend unreachable");
      },
    });
    const got = await handler(EVENT, {});
    // failMode=closed from apiPluginConfig should cause a block (not fail-open)
    expect(got).toMatchObject({ block: true });
    expect(got!.blockReason).toContain("failMode=closed");
  });

  // --- Fix 4: log-once for unconfigured path ---
  it("log-once: unconfigured handler logs exactly once across multiple invocations", async () => {
    const logSpy = vi.fn();
    const handler = createBeforeToolCallHandler({
      edgeConfigPath: "/nonexistent/config.toml",
      log: logSpy,
    });
    await handler(EVENT, {});
    await handler(EVENT, {});
    await handler(EVENT, {});
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  // --- Fix 3: orphaned-hold protection — waitForCheckpoint throws ---
  it("hold wait throw: dropHold still fires and on_timeout=DENY blocks", async () => {
    const env = {
      decision: "HOLD",
      checkpoint_id: "cp1",
      // Expired immediately so the loop hits the deadline path quickly.
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      on_timeout: "DENY" as const,
      title: "Hold test",
    };
    const calls: any[] = [];

    // getCheckpoint always returns pending so the loop never resolves early.
    // sleep throws on first call, which propagates out of waitForCheckpoint.
    let sleepCalls = 0;
    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: () => {},
      notifyHold: async (n) => void calls.push(["notify", n]),
      clearHold: async (id) => void calls.push(["clear", id]),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          getCheckpoint: async () => ({ id: "cp1", status: "pending", effective_decision: "DENY", title: "t", on_timeout: "DENY", expires_at: env.expires_at }),
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
      holdWaitOpts: {
        // Very short poll/deadline so we exercise the throw path quickly.
        maxWaitMs: 1,
        pollMs: 1,
        sleep: async () => {
          sleepCalls++;
          throw new Error("boom");
        },
      },
    });

    const got = await handler(EVENT, {});
    // on_timeout=DENY → should block
    expect(got).toMatchObject({ block: true });
    // dropHold must have been called (["clear", "cp1"] in calls)
    expect(calls.some(([op, id]: any) => op === "clear" && id === "cp1")).toBe(true);
  });

  it("hold wait throw: on_timeout=ALLOW allows through AND dropHold fires", async () => {
    const env = {
      decision: "HOLD",
      checkpoint_id: "cp2",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      on_timeout: "ALLOW" as const,
      title: "Hold allow test",
    };
    const calls: any[] = [];

    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: () => {},
      notifyHold: async (n) => void calls.push(["notify", n]),
      clearHold: async (id) => void calls.push(["clear", id]),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          getCheckpoint: async () => ({ id: "cp2", status: "pending", effective_decision: "ALLOW", title: "t", on_timeout: "ALLOW", expires_at: env.expires_at }),
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
      holdWaitOpts: {
        maxWaitMs: 1,
        pollMs: 1,
        sleep: async () => { throw new Error("boom"); },
      },
    });

    const got = await handler(EVENT, {});
    // on_timeout=ALLOW → should allow
    expect(got).toBeUndefined();
    expect(calls.some(([op, id]: any) => op === "clear" && id === "cp2")).toBe(true);
  });
});

// --- Fix 2: createMessageSendingHandler tests ---
describe("createMessageSendingHandler", () => {
  it("apiPluginConfig fallback with deny decision → cancel: true", async () => {
    const handler = createMessageSendingHandler({
      edgeConfigPath: "/nonexistent/config.toml",
      log: () => {},
      apiPluginConfig: () => ({ deviceToken: "dh_api", failMode: "open", governMessages: true }),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "deny", reason: "no outbound", ruleId: "r2" }),
          getCheckpoint: async () => { throw new Error("unused"); },
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
    });
    const got = await handler({ content: "Hello!", context: {} }, { messageProvider: "slack" } as any);
    expect(got).toMatchObject({ cancel: true });
    expect(got!.cancelReason).toContain("no outbound");
  });

  it("governMessages absent (default off) → undefined without calling evaluate", async () => {
    const evaluateSpy = vi.fn(async () => ({ kind: "allow" as const }));
    const handler = createMessageSendingHandler({
      edgeConfigPath: "/nonexistent/config.toml",
      log: () => {},
      // governMessages not set → defaults false
      apiPluginConfig: () => ({ deviceToken: "dh_api", failMode: "open" }),
      makeClient: () =>
        ({
          evaluate: evaluateSpy,
          getCheckpoint: async () => { throw new Error("unused"); },
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
    });
    const got = await handler({ content: "Hello!" }, {} as any);
    expect(got).toBeUndefined();
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it("governMessages=true with ALLOW → undefined", async () => {
    const handler = createMessageSendingHandler({
      edgeConfigPath: "/nonexistent/config.toml",
      log: () => {},
      apiPluginConfig: () => ({ deviceToken: "dh_api", governMessages: true }),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "allow" as const }),
          getCheckpoint: async () => { throw new Error("unused"); },
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
    });
    const got = await handler({ content: "Hello!" }, {} as any);
    expect(got).toBeUndefined();
  });
});
