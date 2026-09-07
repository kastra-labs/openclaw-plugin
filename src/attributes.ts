import type { ResolvedConfig } from "./config.js";
import type { EvaluateRequest } from "./types.js";
import type { MessageContext, ToolContext, ToolEvent } from "./host-types.js";

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
export type HookCtx = Partial<ToolContext & MessageContext>;

// Canonical attribute mapping. Keys mirror cmd/kastrahook/pre_tool.go so
// rules written for Claude Code / Codex port to OpenClaw unchanged.
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
  if (ctx?.channelId) attrs["x-kastra-attr-openclaw-channel"] = ctx.channelId;
  if (ctx?.accountId) attrs["x-kastra-attr-openclaw-account"] = ctx.accountId;
  if (ctx?.conversationId) attrs["x-kastra-attr-openclaw-conversation"] = ctx.conversationId;
  if (ctx?.runId) attrs["x-kastra-attr-openclaw-run"] = ctx.runId;
  if (ctx?.toolCallId) attrs["x-kastra-attr-openclaw-tool-call"] = ctx.toolCallId;
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
