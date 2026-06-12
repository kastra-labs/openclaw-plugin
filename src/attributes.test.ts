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
  governMessages: false,
  holdMaxWaitMs: 540_000,
};

describe("buildEvaluateRequest", () => {
  it("maps an exec email send to canonical attributes", () => {
    const req = buildEvaluateRequest(
      { toolName: "exec", params: { command: "gog gmail send --to a@b.com --subject Hi --body Hello" } },
      { sessionKey: "s1", agentId: "main", messageProvider: "whatsapp" },
      CFG,
    );
    expect(req.source).toBe("openclaw");
    expect(req.model).toBe("openclaw");
    expect(req.action).toBe("tool_call");
    expect(req.workload_type).toBe("personal-assistant");
    expect(req.environment).toBe("dev");
    expect(req.jurisdiction).toBe("us");
    expect(req.actor).toMatchObject({ email: "f@e.st", device: "dh_x", client: "openclaw-plugin" });
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
  });

  it("omits empty optional fields", () => {
    const req = buildEvaluateRequest({ toolName: "read" }, undefined, { ...CFG, environment: "", userEmail: "" });
    expect(req.environment).toBeUndefined();
    expect(req.actor?.email).toBeUndefined();
    expect(req.attributes!["x-kastra-attr-tool-input"]).toBeUndefined();
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
