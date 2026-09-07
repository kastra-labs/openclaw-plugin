import { describe, expect, it } from "vitest";
import { buildEvaluateRequest, TOOL_INPUT_LIMIT, truncateUTF8 } from "./attributes.js";
import type { ResolvedConfig } from "./config.js";

const CFG: ResolvedConfig = {
  apiBaseUrl: "https://x",
  deviceToken: "dh_x",
  environment: "dev",
  jurisdiction: "us",
  userEmail: "f@e.st",
  consoleBaseUrl: "",
  failMode: "open",
  holdMaxWaitMs: 540_000,
};

describe("buildEvaluateRequest", () => {
  it("maps an exec email send to canonical attributes", () => {
    const req = buildEvaluateRequest(
      { toolName: "exec", params: { command: "gog gmail send --to a@b.com --subject Hi --body Hello" } },
      { sessionKey: "s1", agentId: "main", channelId: "whatsapp" },
      CFG,
    );
    expect(req.source).toBe("openclaw");
    expect(req.model).toBe("openclaw");
    expect(req.action).toBe("tool_call");
    expect(req.workload_type).toBe("personal-assistant");
    expect(req.environment).toBe("dev");
    expect(req.jurisdiction).toBe("us");
    expect(req.actor).toMatchObject({ email: "f@e.st", client: "openclaw-plugin" });
    expect(req.actor?.device).toBeUndefined();
    const a = req.attributes!;
    expect(a["x-kastra-attr-tool"]).toBe("exec");
    expect(a["x-kastra-attr-source-event"]).toBe("pre_tool");
    expect(a["x-kastra-attr-session"]).toBe("s1");
    expect(a["x-kastra-attr-openclaw-agent"]).toBe("main");
    expect(a["x-kastra-attr-openclaw-channel"]).toBe("whatsapp");
    expect(JSON.parse(a["x-kastra-attr-tool-input"])).toEqual({
      command: "gog gmail send --to a@b.com --subject Hi --body Hello",
    });
  });

  it("caps tool-input at TOOL_INPUT_LIMIT bytes", () => {
    const req = buildEvaluateRequest({ toolName: "exec", params: { command: "x".repeat(10_000) } }, undefined, CFG);
    expect(Buffer.byteLength(req.attributes!["x-kastra-attr-tool-input"], "utf8")).toBeLessThanOrEqual(TOOL_INPUT_LIMIT);
    expect(req.attributes).not.toHaveProperty("x-kastra-attr-tool-input-truncated");
  });

  it("clips oversized tool input and flags the truncation instead of refusing to evaluate", () => {
    const req = buildEvaluateRequest({ toolName: "exec", params: { command: "x".repeat(TOOL_INPUT_LIMIT) } }, undefined, CFG);
    const a = req.attributes!;
    expect(Buffer.byteLength(a["x-kastra-attr-tool-input"], "utf8")).toBeLessThanOrEqual(TOOL_INPUT_LIMIT);
    expect(a["x-kastra-attr-tool-input-truncated"]).toBe("true");
  });

  it("drops undefined optional params the way JSON.stringify does", () => {
    const req = buildEvaluateRequest({ toolName: "read", params: { path: "/tmp/a", encoding: undefined } }, undefined, CFG);
    expect(JSON.parse(req.attributes!["x-kastra-attr-tool-input"])).toEqual({ path: "/tmp/a" });
  });

  it("serializes a Date to ISO 8601 rather than refusing the call", () => {
    const req = buildEvaluateRequest({ toolName: "search", params: { since: new Date(0) } }, undefined, CFG);
    expect(JSON.parse(req.attributes!["x-kastra-attr-tool-input"])).toEqual({ since: "1970-01-01T00:00:00.000Z" });
  });

  it("still refuses a Date carrying its own toJSON", () => {
    const spoofed = new Date(9e12);
    spoofed.toJSON = () => "1970-01-01T00:00:00.000Z";
    expect(() => buildEvaluateRequest({ toolName: "search", params: { since: spoofed } }, undefined, CFG)).toThrow();
  });

  it("still refuses a Date subclass whose toJSON hides the real value", () => {
    class Masked extends Date { toJSON() { return "1970-01-01T00:00:00.000Z"; } }
    expect(() => buildEvaluateRequest({ toolName: "search", params: { since: new Masked(9e12) } }, undefined, CFG)).toThrow();
  });

  it("omits empty optional fields", () => {
    const req = buildEvaluateRequest({ toolName: "read" }, undefined, { ...CFG, environment: "", userEmail: "" });
    expect(req.environment).toBeUndefined();
    expect(req.actor?.email).toBeUndefined();
    expect(req.attributes!["x-kastra-attr-tool-input"]).toBeUndefined();
  });

  it("rejects unserializable params instead of evaluating a sentinel", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => buildEvaluateRequest({ toolName: "exec", params: circular }, undefined, CFG)).toThrow();
  });
});

describe("truncateUTF8", () => {
  it("never splits a multi-byte character", () => {
    const s = "é".repeat(3000); // 2 bytes each
    const out = truncateUTF8(s, 4096);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/^é+$/); // still valid characters only
  });
});
