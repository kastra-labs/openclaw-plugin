import { describe, expect, it, vi } from "vitest";
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({ definePluginEntry: (entry: unknown) => entry }));
import plugin from "./index.js";
import { effectiveHookTimeout } from "./config.js";

describe("host registration", () => {
  it("authors a 600-second budget for BOTH governed hooks", () => {
    const api = { on: vi.fn(), config: {}, runtime: { state: { resolveStateDir: () => "/nonexistent/test-state" } } };
    (plugin as any).register(api);
    expect(api.on.mock.calls.map(([hook, , options]) => [hook, options])).toEqual([
      ["before_tool_call", { priority: 100, timeoutMs: 600000 }],
      ["message_sending", { priority: 100, timeoutMs: 600000 }],
    ]);
  });
  it("matches per-hook, plugin-wide, and authored timeout precedence", () => {
    expect(effectiveHookTimeout({ timeoutMs: 100, timeouts: { message_sending: 50 } }, "message_sending")).toBe(50);
    expect(effectiveHookTimeout({ timeoutMs: 100 }, "before_tool_call")).toBe(100);
    expect(effectiveHookTimeout(undefined, "message_sending")).toBe(600000);
    expect(effectiveHookTimeout({ timeoutMs: 900000 }, "message_sending")).toBe(600000);
  });
});
