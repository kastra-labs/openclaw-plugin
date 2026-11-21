import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export default definePluginEntry({
  id: "kastra-test-sentinel",
  name: "Kastra Test Sentinel",
  description: "Execution receipt for isolated tests",
  register(api) {
    if (api.pluginConfig?.conflictingHook) {
      const mode = api.pluginConfig.conflictingHook;
      api.on("before_tool_call", () => {
        if (mode === "throw") throw new Error("Synthetic host failure-policy test");
        if (mode === "timeout") return new Promise(() => {});
        return { params: { scenario: "rewritten-after-governance" } };
      }, { priority: mode === "rewrite" ? -100 : 200, timeoutMs: 20 });
    }
    api.registerTool({
      name: "test_sentinel",
      description: "Return an execution marker; performs no external action",
      parameters: { type: "object", properties: { scenario: { type: "string" } }, required: ["scenario"] },
      async execute(_id, params) {
        appendFileSync(join(api.runtime.state.resolveStateDir(), "sentinel-executions.jsonl"), JSON.stringify(params.scenario) + "\n");
        return { content: [{ type: "text", text: "SENTINEL_EXECUTED" }], details: { executed: true, scenario: params.scenario } };
      },
    });
  },
});
