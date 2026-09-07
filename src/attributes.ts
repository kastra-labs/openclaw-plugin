import type { ResolvedConfig } from "./config.js";
import type { EvaluateRequest } from "./types.js";
import type { MessageContext, ToolContext, ToolEvent } from "./host-types.js";
import { parseAgentSessionKey, resolveGatewayMessageChannel } from "openclaw/plugin-sdk/routing";

// Never send a prefix that can hide policy-relevant input.
export const TOOL_INPUT_LIMIT = 256 * 1024;

export class InvalidInputError extends Error {
  constructor() { super("Kastra cannot govern non-JSON or oversized input"); }
}

export function serializeInput(input: unknown): string {
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > 100) throw new InvalidInputError();
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || seen.has(value)) throw new InvalidInputError();
    const array = Array.isArray(value);
    if (array && Object.getPrototypeOf(value) !== Array.prototype) throw new InvalidInputError();
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new InvalidInputError();
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new InvalidInputError();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new InvalidInputError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new InvalidInputError();
      visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
  }
  try {
    visit(input, 0);
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, "utf8") > TOOL_INPUT_LIMIT) throw new InvalidInputError();
    return serialized;
  } catch { throw new InvalidInputError(); }
}

export type HookEvent = Pick<ToolEvent, "toolName"> & Partial<Omit<ToolEvent, "toolName">>;
export type HookCtx = Partial<ToolContext & MessageContext> & { messageProvider?: string };

export function messageProvider(ctx: HookCtx | undefined): string | undefined {
  if (ctx?.messageProvider) return ctx.messageProvider;
  const route = parseAgentSessionKey(ctx?.sessionKey)?.rest.split(":");
  const routed = route && route.length >= 3 ? resolveGatewayMessageChannel(route[0]) : undefined;
  // Tool channelId may be an opaque peer ID; only accept a registered provider.
  return routed ?? resolveGatewayMessageChannel(ctx?.channelId);
}

// Shared attribute names match the hook vocabulary. Tool names and provider-
// specific input schemas still need matching policy conditions.
export function buildEvaluateRequest(event: HookEvent, ctx: HookCtx | undefined, cfg: ResolvedConfig): EvaluateRequest {
  const attrs: Record<string, string> = {
    "x-kastra-attr-tool": event.toolName,
    "x-kastra-attr-source-event": "pre_tool",
    "x-kastra-attr-os": process.platform,
    "x-kastra-attr-arch": process.arch,
  };
  if (event.toolKind) attrs["x-kastra-attr-tool-kind"] = event.toolKind;
  if (ctx?.sessionKey) attrs["x-kastra-attr-session"] = String(ctx.sessionKey);
  if (ctx?.agentId) attrs["x-kastra-attr-openclaw-agent"] = String(ctx.agentId);
  const provider = messageProvider(ctx);
  if (provider) attrs["x-kastra-attr-openclaw-channel"] = provider;
  const runId = ctx?.runId ?? event.runId;
  const toolCallId = ctx?.toolCallId ?? event.toolCallId;
  if (runId) attrs["x-kastra-attr-turn-id"] = runId;
  if (toolCallId) attrs["x-kastra-attr-tool-use-id"] = toolCallId;
  if (event.params !== undefined) attrs["x-kastra-attr-tool-input"] = serializeInput(event.params);
  return {
    environment: cfg.environment || undefined,
    jurisdiction: cfg.jurisdiction,
    model: "openclaw",
    workload_type: "personal-assistant",
    action: "tool_call",
    source: "openclaw",
    actor: {
      email: cfg.userEmail || undefined,
      os: process.platform,
      client: "openclaw-plugin",
    },
    attributes: attrs,
  };
}

export function truncateUTF8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off mid-codepoint
  return buf.subarray(0, end).toString("utf8");
}
