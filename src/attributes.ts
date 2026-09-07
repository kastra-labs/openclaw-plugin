import type { ResolvedConfig } from "./config.js";
import type { EvaluateRequest } from "./types.js";
import type { MessageContext, ToolContext, ToolEvent } from "./host-types.js";
import { parseAgentSessionKey, resolveGatewayMessageChannel } from "openclaw/plugin-sdk/routing";

// Never send a prefix that can hide policy-relevant input.
export const TOOL_INPUT_LIMIT = 256 * 1024;

export class InvalidInputError extends Error {
  constructor() { super("Kastra cannot govern non-JSON or oversized input"); }
}

// Faithfulness, not strictness, is the goal: what policy sees must be what the
// tool receives. Values JSON.stringify represents exactly (undefined dropped, a
// Date as ISO 8601) are accepted; anything whose own toJSON could show policy a
// different value than the tool acts on is refused.
export function serializeInput(input: unknown): string {
  if (input === undefined) throw new InvalidInputError();
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > 100) throw new InvalidInputError();
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || seen.has(value)) throw new InvalidInputError();
    // Exactly Date, never a subclass: an overridden toJSON is the evasion this guards.
    if (Object.getPrototypeOf(value) === Date.prototype) return;
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
    return JSON.stringify(input);
  } catch { throw new InvalidInputError(); }
}

export type HookEvent = Pick<ToolEvent, "toolName"> & Partial<Omit<ToolEvent, "toolName">>;
export type HookCtx = Partial<ToolContext & MessageContext> & { messageProvider?: string };

// One resolution for both hooks, so a rule keyed on the provider means the same
// thing whether it matched a tool call or an outbound message.
export function messageProvider(ctx: HookCtx | undefined): string | undefined {
  // The host's own answer to "which channel is this?" outranks every inference.
  if (ctx?.requester?.channel) return String(ctx.requester.channel);
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
  if (event.params !== undefined) {
    // Clip and flag rather than refuse: an oversized payload is still a call
    // policy should get to judge, and the flag is what makes the clipping
    // visible to a rule. Same contract as the Claude Code / Codex hook.
    const serialized = serializeInput(event.params);
    const clipped = truncateUTF8(serialized, TOOL_INPUT_LIMIT);
    attrs["x-kastra-attr-tool-input"] = clipped;
    if (clipped.length < serialized.length) attrs["x-kastra-attr-tool-input-truncated"] = "true";
  }
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
