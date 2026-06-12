import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";
import { createBeforeToolCallHandler } from "./handler.js";

export default definePluginEntry({
  id: "kastra",
  name: "Kastra Governance",
  register(api) {
    const handler = createBeforeToolCallHandler({
      log: (m) => (api.logger?.warn ? api.logger.warn(m) : console.warn(`[kastra] ${m}`)),
    });

    api.on("before_tool_call", handler, { priority: 100 });

    // Optional outbound chat-message gate (config flag, default off):
    // evaluates channel replies as a synthetic "openclaw_message" tool call
    // and cancels delivery on DENY / unapproved HOLD.
    api.on(
      "message_sending",
      async (event: any, ctx: any) => {
        const cfg = resolveConfig(event?.context?.pluginConfig ?? api.pluginConfig);
        if ("error" in cfg || !cfg.governMessages) return undefined;
        const result = await handler(
          {
            toolName: "openclaw_message",
            params: {
              content: String(event?.content ?? "").slice(0, 2000),
              channel: String(ctx?.messageProvider ?? ""),
            },
            context: event?.context,
          },
          ctx,
        );
        if (result?.block) return { cancel: true, cancelReason: result.blockReason };
        return undefined;
      },
      { priority: 100 },
    );
  },
});
