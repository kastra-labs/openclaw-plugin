import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_API_BASE_URL, readEdgeConfig, resolveConfig } from "./config.js";

function writeToml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kastra-test-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

describe("readEdgeConfig", () => {
  it("extracts known keys from flat TOML", () => {
    const path = writeToml(
      `api_base_url = "https://demo.kastra.ai"\ndevice_handle = "dh_abc123"\ndefault_environment = "dev"\ndefault_jurisdiction = "us"\nuser_email = "f@e.st"\n`,
    );
    expect(readEdgeConfig(path)).toEqual({
      api_base_url: "https://demo.kastra.ai",
      device_handle: "dh_abc123",
      default_environment: "dev",
      default_jurisdiction: "us",
      user_email: "f@e.st",
    });
  });

  it("returns {} for a missing file", () => {
    expect(readEdgeConfig("/nonexistent/config.toml")).toEqual({});
  });

  it("handles CRLF line endings without tainting values", () => {
    const lines = [
      `api_base_url = "https://demo.kastra.ai"`,
      `device_handle = "dh_crlf"`,
      `default_environment = "staging"`,
    ];
    const path = writeToml(lines.join("\r\n") + "\r\n");
    const got = readEdgeConfig(path);
    expect(got.device_handle).toBe("dh_crlf");
    expect(got.default_environment).toBe("staging");
    expect(got.api_base_url).toBe("https://demo.kastra.ai");
    // Ensure no \r leaked into any value
    for (const v of Object.values(got)) {
      expect(v).not.toMatch(/\r/);
    }
  });

  it("first match wins (flat key before any section shadow)", () => {
    // kastra-edge's encoder writes flat keys before sections; first-match
    // semantics via RegExp multiline anchors guarantees the top-level value wins.
    const path = writeToml(
      [
        `device_handle = "dh_top"`,
        ``,
        `[cache]`,
        `device_handle = "dh_section"`,
      ].join("\n") + "\n",
    );
    expect(readEdgeConfig(path).device_handle).toBe("dh_top");
  });

  it("handles escaped quotes inside a TOML value", () => {
    const path = writeToml(`device_handle = "dh_\\"special\\""\n`);
    expect(readEdgeConfig(path).device_handle).toBe(`dh_"special"`);
  });
});

describe("resolveConfig", () => {
  it("errors without any device token", () => {
    const got = resolveConfig({}, "/nonexistent/config.toml");
    expect(got).toHaveProperty("error");
  });

  it("plugin config wins over TOML; defaults fill the rest", () => {
    const path = writeToml(`device_handle = "dh_toml"\ndefault_environment = "dev"\n`);
    const got = resolveConfig({ deviceToken: "dh_plugin", environment: "prod" }, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.deviceToken).toBe("dh_plugin");
    expect(got.environment).toBe("prod");
    expect(got.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(got.jurisdiction).toBe("us-east");
    expect(got.failMode).toBe("open");
    expect(got.governMessages).toBe(false);
    expect(got.holdMaxWaitMs).toBe(540_000);
  });

  it("clamps holdMaxWaitMs values at or above the budget cap to 540_000", () => {
    const path = writeToml(`device_handle = "dh_x"\n`);
    const got = resolveConfig({ deviceToken: "dh_x", holdMaxWaitMs: 600_000 }, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.holdMaxWaitMs).toBe(540_000);
  });

  it("defaults holdMaxWaitMs to 540_000 when value is 0", () => {
    const path = writeToml(`device_handle = "dh_x"\n`);
    const got = resolveConfig({ deviceToken: "dh_x", holdMaxWaitMs: 0 }, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.holdMaxWaitMs).toBe(540_000);
  });

  it("defaults holdMaxWaitMs to 540_000 when value is -1", () => {
    const path = writeToml(`device_handle = "dh_x"\n`);
    const got = resolveConfig({ deviceToken: "dh_x", holdMaxWaitMs: -1 }, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.holdMaxWaitMs).toBe(540_000);
  });

  it("treats wrong-case failMode as 'open'", () => {
    const path = writeToml(`device_handle = "dh_x"\n`);
    const got = resolveConfig({ deviceToken: "dh_x", failMode: "CLOSED" }, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.failMode).toBe("open");
  });

  it("falls back to TOML device handle and environment", () => {
    const path = writeToml(
      `device_handle = "dh_toml"\napi_base_url = "https://demo.kastra.ai"\ndefault_environment = "dev"\nadmin_console_url = "https://app.kastra.ai"\n`,
    );
    const got = resolveConfig(undefined, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.deviceToken).toBe("dh_toml");
    expect(got.apiBaseUrl).toBe("https://demo.kastra.ai");
    expect(got.environment).toBe("dev");
    expect(got.consoleBaseUrl).toBe("https://app.kastra.ai");
  });
});
