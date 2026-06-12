import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBeforeToolCallHandler, createMessageSendingHandler } from "./handler.js";

export default definePluginEntry({
  id: "kastra",
  name: "Kastra Governance",
  register(api) {
    const log = (m: string) => (api.logger?.warn ? api.logger.warn(m) : console.warn(`[kastra] ${m}`));

    api.on(
      "before_tool_call",
      createBeforeToolCallHandler({
        log,
        apiPluginConfig: () => api.pluginConfig,
      }),
      { priority: 100 },
    );

    // Optional outbound chat-message gate (config flag, default off):
    // evaluates channel replies as a synthetic "openclaw_message" tool call
    // and cancels delivery on DENY / unapproved HOLD.
    api.on(
      "message_sending",
      createMessageSendingHandler({
        log,
        apiPluginConfig: () => api.pluginConfig,
      }),
      { priority: 100 },
    );
  },
});
