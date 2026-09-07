import { describe, expect, it, vi } from "vitest";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";

describe("asynchronous durable authorization", () => {
  for (const surface of ["tool", "message"] as const) {
    it(`${surface} denies an asynchronous journal failure`, async () => {
      const deps = { edgeConfigPath: "/nonexistent/fixture.toml", apiPluginConfig: () => ({ governMessages: true }),
        recordOutcome: async () => { throw new Error("Fixture persistence failure"); }, log: () => {} };
      const result = surface === "tool" ? await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {} }) :
        await createMessageSendingHandler(deps)({ content: "Fixture", to: "recipient" });
      expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
    });
    it(`${surface} waits for durable completion`, async () => {
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const recordOutcome = vi.fn(() => pending);
      const deps = { edgeConfigPath: "/nonexistent/fixture.toml", apiPluginConfig: () => ({ governMessages: true }), recordOutcome, log: () => {} };
      let finished = false;
      const result = (surface === "tool" ? createBeforeToolCallHandler(deps)({ toolName: "exec", params: {} }) :
        createMessageSendingHandler(deps)({ content: "Fixture", to: "recipient" })).then(value => { finished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 10));
      try { expect(finished).toBe(false); } finally { release(); await result; }
    });
    it(`${surface} denies a stalled recorder inside a short host budget`, async () => {
      const deps = { edgeConfigPath: "/nonexistent/fixture.toml", apiPluginConfig: () => ({ governMessages: true }),
        recordOutcome: () => new Promise<void>(() => {}), hookTimeoutMs: () => 200, log: () => {} };
      const started = Date.now();
      const result = surface === "tool" ? await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {} }) :
        await createMessageSendingHandler(deps)({ content: "Fixture", to: "recipient" });
      expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
      expect(Date.now() - started).toBeLessThan(200);
    });
  }
  it("does not authorize when the caller cancels during recording", async () => {
    const controller = new AbortController();
    const deps = { edgeConfigPath: "/nonexistent/fixture.toml", recordOutcome: async () => { controller.abort(); }, log: () => {} };
    expect(await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {} }, { abortSignal: controller.signal })).toMatchObject({ block: true });
  });
});
