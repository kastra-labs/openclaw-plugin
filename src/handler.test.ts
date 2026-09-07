import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBeforeToolCallHandler as toolHandler, createMessageSendingHandler as messageHandler, type HandlerDeps } from "./handler.js";
import type { Decision } from "./types.js";

const createBeforeToolCallHandler = (deps: HandlerDeps = {}) => toolHandler({ recordOutcome: () => {}, ...deps });
const createMessageSendingHandler = (deps: HandlerDeps = {}) => messageHandler({ recordOutcome: () => {}, ...deps });

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

  // Force a wait failure independently of deadline timing; verify its recorded
  // disposition and notification cleanup for both timeout policies.
  it("hold wait failure denies and clears the notification with on_timeout=DENY", async () => {
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
    const recordOutcome = vi.fn();

    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: logSpy,
      recordOutcome,
      notifyHold: async (n) => void calls.push(["notify", n]),
      clearHold: async (id) => void calls.push(["clear", id]),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          // Always pending → the loop never resolves early; it must hit sleep.
          getCheckpoint: async () => ({ id: "cp1", status: "pending", title: "t", on_timeout: "DENY", expires_at: env.expires_at }),
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
    expect(got).toMatchObject({ block: true });
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ decision: "DENY", disposition: "hold_error" }));
    // finally{} guarantees dropHold fired.
    expect(calls.some(([op, id]: any) => op === "clear" && id === "cp1")).toBe(true);
  });

  it("hold wait failure denies and clears the notification even with on_timeout=ALLOW", async () => {
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
    const recordOutcome = vi.fn();

    const handler = createBeforeToolCallHandler({
      edgeConfigPath: tomlPath,
      log: logSpy,
      recordOutcome,
      notifyHold: async (n) => void calls.push(["notify", n]),
      clearHold: async (id) => void calls.push(["clear", id]),
      makeClient: () =>
        ({
          evaluate: async () => ({ kind: "hold", envelope: env }),
          getCheckpoint: async () => ({ id: "cp2", status: "pending", title: "t", on_timeout: "ALLOW", expires_at: env.expires_at }),
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
    expect(got).toMatchObject({ block: true });
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ decision: "DENY", disposition: "hold_error" }));
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
    const got = await handler({ to: "recipient", content: "Hello!", context: {} }, { channelId: "slack" });
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
    const got = await handler({ to: "recipient", content: "Hello!" }, {});
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
    const got = await handler({ to: "recipient", content: "Hello!" }, {});
    expect(got).toBeUndefined();
  });
});

it("emits an escaped canonical approval link from the actual hold handler",async()=>{
 const {handler,calls}=handlerWith({kind:"hold",envelope:{decision:"HOLD",checkpoint_id:"a&b",title:"Review",on_timeout:"DENY",expires_at:new Date(Date.now()+60000).toISOString()}});
 await handler({...EVENT,context:{pluginConfig:{consoleBaseUrl:"https://private.test/console/"}}},{});
 expect(calls.find(([op])=>op==="notify")?.[1].console_url).toBe("https://private.test/console/approvals?checkpoint=a%26b");
});
it.each(["open","closed"])("configuration validation preserves failMode=%s without creating a client",async(failMode)=>{
 const makeClient=vi.fn();const log=vi.fn();
 const handler=createBeforeToolCallHandler({edgeConfigPath:tomlPath,makeClient,log});
 const result=await handler({...EVENT,context:{pluginConfig:{apiBaseUrl:"https://user:secret@example.test",failMode}}},{});
 expect(makeClient).not.toHaveBeenCalled();expect(log).toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
 if(failMode==="closed")expect(result).toMatchObject({block:true});else expect(result).toBeUndefined();
});

it.each(["console_base_url"])("still enforces policy with invalid optional %s", async (key) => {
  const path = join(mkdtempSync(join(tmpdir(), "kastra-console-")), "config.toml");
  writeFileSync(path, `device_handle="dh_x"\n${key}="invalid-display-url"\n`);
  const log = vi.fn();
  const {handler} = handlerWith({kind:"deny", reason:"policy blocked"}, {edgeConfigPath:path, log});
  for (let i=0;i<2;i++) expect(await handler(EVENT, {})).toMatchObject({block:true, blockReason:expect.stringContaining("policy blocked")});
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("approval links disabled"));
});
