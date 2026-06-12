import type { ResolvedConfig } from "./config.js";
import type { EvaluateRequest } from "./types.js";

// Same cap kastrahook applies to x-kastra-attr-tool-input (4 KiB).
export const TOOL_INPUT_LIMIT = 4096;

export type HookEvent = {
  toolName: string;
  params?: Record<string, unknown>;
  toolKind?: string;
};

export type HookCtx = {
  agentId?: string;
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
};

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
  if (ctx?.messageProvider) attrs["x-kastra-attr-openclaw-channel"] = String(ctx.messageProvider);
  if (event.params && Object.keys(event.params).length > 0) {
    attrs["x-kastra-attr-tool-input"] = truncateUTF8(JSON.stringify(event.params), TOOL_INPUT_LIMIT);
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
      device: cfg.deviceToken,
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
