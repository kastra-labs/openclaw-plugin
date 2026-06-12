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

  // --- Fix 3: orphaned-hold protection — waitForCheckpoint genuinely REJECTS ---
  //
  // These tests MUST reach the `await sleep(pollMs)` at hold.ts:91 (OUTSIDE any
  // try) and let the rejection propagate into handler.ts's catch. A naive setup
  // (maxWaitMs:1 + expired envelope) races the deadline return against the sleep
  // throw and can silently take the on_timeout DEADLINE path instead — a false
  // pin. To force the catch deterministically we give a LARGE server-intended
  // TTL (server_now + far-future expires_at) so the deadline is far away on the
  // first iteration; getCheckpoint stays pending; sleep always rejects → the
  // first iteration is guaranteed to reach sleep and throw. We additionally
  // assert the `hold wait failed:` log to PROVE the catch (not the deadline)
  // produced the result.
  it("hold wait REJECTS: dropHold still fires and catch applies on_timeout=DENY (blocks)", async () => {
    const now = Date.now();
    const env = {
      decision: "HOLD",
      checkpoint_id: "cp1",
      server_now: new Date(now).toISOString(),
      // Far-future expiry → large TTL → deadline is far away → deadline path
      // cannot win the race; the loop must reach `await sleep`.
      expires_at: new Date(now + 600_000).toISOString(),
      on_timeout: "DENY" as const,
      title: "Hold test",
    };
    const calls: any[] = [];
    const logSpy = vi.fn();

    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: logSpy,
      notifyHold: async (n) => void calls.push(["notify", n]),
      clearHold: async (id) => void calls.push(["clear", id]),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          // Always pending → the loop never resolves early; it must hit sleep.
          getCheckpoint: async () => ({ id: "cp1", status: "pending", effective_decision: "DENY", title: "t", on_timeout: "DENY", expires_at: env.expires_at }),
          heartbeat: async () => {},
          cancel: async () => {},
        }) as any,
      holdWaitOpts: {
        // sleep at hold.ts:91 rejects → propagates out of waitForCheckpoint.
        sleep: async () => {
          throw new Error("boom");
        },
      },
    });

    const got = await handler(EVENT, {});
    // Catch applied on_timeout=DENY → should block.
    expect(got).toMatchObject({ block: true });
    // PROOF the catch (not the deadline path) ran: the catch logs this string.
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("hold wait failed:"))).toBe(true);
    // finally{} guarantees dropHold fired.
    expect(calls.some(([op, id]: any) => op === "clear" && id === "cp1")).toBe(true);
  });

  it("hold wait REJECTS: catch applies on_timeout=ALLOW (allows through) AND dropHold fires", async () => {
    const now = Date.now();
    const env = {
      decision: "HOLD",
      checkpoint_id: "cp2",
      server_now: new Date(now).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(),
      on_timeout: "ALLOW" as const,
      title: "Hold allow test",
    };
    const calls: any[] = [];
    const logSpy = vi.fn();

    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: logSpy,
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
        sleep: async () => {
          throw new Error("boom");
        },
      },
    });

    const got = await handler(EVENT, {});
    // on_timeout=ALLOW distinguishes the catch's on_timeout branch from BOTH a
    // failMode-closed default AND any deny-bias fallback → an ALLOW result here
    // can only have come from the catch reading env.on_timeout.
    expect(got).toBeUndefined();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("hold wait failed:"))).toBe(true);
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
