import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

declare const on: OpenClawPluginApi["on"];
export type ToolHandler = Parameters<typeof on<"before_tool_call">>[1];
export type MessageHandler = Parameters<typeof on<"message_sending">>[1];
export type ToolEvent = Parameters<ToolHandler>[0];
export type ToolContext = Parameters<ToolHandler>[1];
export type MessageEvent = Parameters<MessageHandler>[0];
export type MessageContext = Parameters<MessageHandler>[1];
