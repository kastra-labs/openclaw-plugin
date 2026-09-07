import { describe, expect, it, vi } from "vitest";
import { buildEvaluateRequest } from "./attributes.js";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";

const edgeConfigPath = "/nonexistent/context-fixture.toml";
const cfg = resolveConfig({ deviceToken: "dh_fixture" }, edgeConfigPath);
if ("error" in cfg) throw new Error("Invalid test configuration");

describe("stable policy context", () => {
  it("preserves the legacy provider rather than an opaque tool channel ID", () => {
    const request = buildEvaluateRequest({ toolName: "exec", params: {} }, { messageProvider: "slack", channelId: "C-fixture" } as any, cfg);
    expect(request.attributes!["x-kastra-attr-openclaw-channel"]).toBe("slack");
  });
  it.each(["agent:main:slack:channel:C-fixture", "agent:main:slack:work:direct:U-fixture"])("resolves the tool provider from routed session %s", sessionKey => {
    expect(buildEvaluateRequest({ toolName: "exec" }, { sessionKey, channelId: "C-fixture" }, cfg).attributes!["x-kastra-attr-openclaw-channel"]).toBe("slack");
  });
  it("never treats an opaque destination or a generic session as a provider", () => {
    expect(buildEvaluateRequest({ toolName: "exec" }, { channelId: "C-fixture", sessionKey: "agent:main:main" }, cfg).attributes)
      .not.toHaveProperty("x-kastra-attr-openclaw-channel");
  });
  it("uses canonical correlation keys including event-level fallbacks", () => {
    const attributes = buildEvaluateRequest({ toolName: "exec", toolCallId: "call-fixture", runId: "run-fixture" }, {}, cfg).attributes!;
    expect(attributes["x-kastra-attr-tool-use-id"]).toBe("call-fixture");
    expect(attributes["x-kastra-attr-turn-id"]).toBe("run-fixture");
    expect(Object.keys(attributes)).not.toEqual(expect.arrayContaining(["x-kastra-attr-openclaw-run", "x-kastra-attr-openclaw-tool-call"]));
  });
  it("carries message account/conversation in input without inventing policy keys", async () => {
    const evaluate = vi.fn(async () => ({ kind: "allow" as const }));
    const handler = createMessageSendingHandler({ edgeConfigPath, apiPluginConfig: () => ({ deviceToken: "dh_fixture", governMessages: true }),
      makeClient: () => ({ evaluate, heartbeat: async () => {}, cancel: async () => {}, getCheckpoint: async () => { throw new Error("Unexpected HOLD"); } }), recordOutcome: () => {} });
    await handler({ to: "C-fixture", content: "Fixture" }, { channelId: "slack", accountId: "account-fixture", conversationId: "conversation-fixture" });
    const attributes = (evaluate.mock.calls as any)[0][0].attributes;
    expect(attributes["x-kastra-attr-openclaw-channel"]).toBe("slack");
    expect(attributes).not.toHaveProperty("x-kastra-attr-openclaw-account");
    expect(attributes).not.toHaveProperty("x-kastra-attr-openclaw-conversation");
    expect(JSON.parse(attributes["x-kastra-attr-tool-input"])).toMatchObject({ accountId: "account-fixture", conversationId: "conversation-fixture" });
  });
});

describe("configuration ownership", () => {
  for (const surface of ["tool", "message"] as const) {
    it(`${surface} honors trusted legacy config when API config is empty`, async () => {
      const records: unknown[] = [];
      const deps = { edgeConfigPath, apiPluginConfig: () => ({}), recordOutcome: (record: unknown) => { records.push(record); }, log: () => {} };
      const context = { pluginConfig: { deviceToken: "", failMode: "closed", governMessages: true } };
      const result = surface === "tool" ? await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {}, context }) :
        await createMessageSendingHandler(deps)({ to: "recipient", content: "Fixture", context });
      expect(result).toMatchObject(surface === "tool" ? { block: true } : { cancel: true });
      expect(records).toMatchObject([{ decision: "DENY", disposition: "unconfigured", failMode: "closed" }]);
    });
  }
  it("does not let legacy event data override a nonempty host configuration", async () => {
    const deps = { edgeConfigPath, apiPluginConfig: () => ({ failMode: "closed" }), recordOutcome: () => {}, log: () => {} };
    expect(await createBeforeToolCallHandler(deps)({ toolName: "exec", params: {}, context: { pluginConfig: { failMode: "open" } } })).toMatchObject({ block: true });
  });
  it("reads message configuration once per invocation", async () => {
    const apiPluginConfig = vi.fn(() => ({ failMode: "closed", governMessages: true }));
    await createMessageSendingHandler({ edgeConfigPath, apiPluginConfig, recordOutcome: () => {}, log: () => {} })({ to: "recipient", content: "Fixture" });
    expect(apiPluginConfig).toHaveBeenCalledTimes(1);
  });
});
