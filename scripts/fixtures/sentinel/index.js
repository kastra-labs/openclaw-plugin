import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export default definePluginEntry({
  id: "kastra-test-sentinel",
  name: "Kastra Test Sentinel",
  description: "In-memory execution marker for isolated tests",
  register(api) {
    api.registerTool({
      name: "test_sentinel",
      description: "Return an execution marker; performs no external action",
      parameters: { type: "object", properties: { scenario: { type: "string" } }, required: ["scenario"] },
      async execute(_id, params) {
        return { content: [{ type: "text", text: "SENTINEL_EXECUTED" }], details: { executed: true, scenario: params.scenario } };
      },
    });
  },
});
