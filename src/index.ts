import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";
import { DEFAULT_HOOK_TIMEOUT_MS, effectiveHookTimeout } from "./config.js";
import { createOutcomeRecorder } from "./outcomes.js";
import { join } from "node:path";

export default definePluginEntry({
  id: "kastra",
  name: "Kastra Governance",
  description: "Policy-enforced tool calls and outbound messages with recorded governance outcomes",
  register(api) {
    const log = (m: string) => (api.logger?.warn ? api.logger.warn(m) : console.warn(`[kastra] ${m}`));
    const recordOutcome = createOutcomeRecorder({ path: join(api.runtime.state.resolveStateDir(), "kastra", "outcomes.jsonl") });

    api.on(
      "before_tool_call",
      createBeforeToolCallHandler({
        log,
        recordOutcome,
        hookTimeoutMs: () => effectiveHookTimeout(api.config.plugins?.entries?.kastra?.hooks, "before_tool_call"),
        apiPluginConfig: () => api.pluginConfig,
      }),
      { priority: 100, timeoutMs: DEFAULT_HOOK_TIMEOUT_MS },
    );

    // Optional outbound chat-message gate (config flag, default off):
    // evaluates channel replies as a synthetic "openclaw_message" tool call
    // and cancels delivery on DENY / unapproved HOLD.
    api.on(
      "message_sending",
      createMessageSendingHandler({
        log,
        recordOutcome,
        hookTimeoutMs: () => effectiveHookTimeout(api.config.plugins?.entries?.kastra?.hooks, "message_sending"),
        apiPluginConfig: () => api.pluginConfig,
      }),
      { priority: 100, timeoutMs: DEFAULT_HOOK_TIMEOUT_MS },
    );
  },
});
