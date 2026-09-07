import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_API_BASE_URL, kastraEdgeConfigPath, readEdgeConfig, resolveConfig } from "./config.js";

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
      `device_handle = "dh_toml"\napi_base_url = "https://demo.kastra.ai"\ndefault_environment = "dev"\nconsole_base_url = "https://app.kastra.ai"\n`,
    );
    const got = resolveConfig(undefined, path);
    if ("error" in got) throw new Error(got.error);
    expect(got.deviceToken).toBe("dh_toml");
    expect(got.apiBaseUrl).toBe("https://demo.kastra.ai");
    expect(got.environment).toBe("dev");
    expect(got.consoleBaseUrl).toBe("https://app.kastra.ai");
  });
});

const minimalToken = 'device_handle="dh_test"\n';
it("reads KASTRA_CONFIG and rejects the retired KASTRA_EDGE_CONFIG whenever it is set", () => {
 expect(kastraEdgeConfigPath({KASTRA_CONFIG:"/new.toml"})).toBe("/new.toml");
 // Retired: an error even when it names the same file, so a stale dotfile can never select a file silently.
 expect(()=>kastraEdgeConfigPath({KASTRA_EDGE_CONFIG:"/old.toml"})).toThrow("no longer read");
 expect(()=>kastraEdgeConfigPath({KASTRA_CONFIG:"/same.toml",KASTRA_EDGE_CONFIG:"/same.toml"})).toThrow("no longer read");
 expect(kastraEdgeConfigPath({XDG_CONFIG_HOME:"/config"})).toBe("/config/kastra/config.toml");
 expect(kastraEdgeConfigPath({})).toMatch(/\.kastra[/\\]config.toml$/);
});
it("parses literal strings, Unicode escapes and sections without shadowing", () => {
 const path=writeToml(String.raw`device_handle = 'dh_literal'
user_email = "user\u0040example.test"
[cache]
api_base_url = "https://foreign.test"
`);
 expect(readEdgeConfig(path)).toEqual({device_handle:"dh_literal",user_email:"user@example.test"});
});
it("reads console_base_url only (admin_console_url is the admin console), with explicit plugin precedence",()=>{
 // Same rule as kastra-edge: explicit console_base_url wins; a known SaaS API host derives its console; a private host without it has none.
 const privateApi='api_base_url="https://private.test/api"\n';
 for(const [content,want] of [["", "https://app.kastra.ai"],['api_base_url="https://api.demo.kastra.ai"',"https://demo.kastra.ai"],[privateApi,""],[privateApi+'admin_console_url="https://old.test/"',""],[privateApi+'console_base_url="https://new.test/"',"https://new.test"],['console_base_url="https://new.test/"\nadmin_console_url="https://old.test"',"https://new.test"]]){
  const path=writeToml(minimalToken+content);
  expect(resolveConfig({},path)).toMatchObject({consoleBaseUrl:want});
  expect(resolveConfig({consoleBaseUrl:"https://explicit.test/console/"},path)).toMatchObject({consoleBaseUrl:"https://explicit.test/console"});
 }
});
it("reports malformed and wrong-type TOML rather than falling back",()=>{
 for(const bad of ['device_handle=1', 'device_handle="broken', '[cache]\napi_base_url="https://foreign.test"']) expect(resolveConfig({},writeToml(bad))).toHaveProperty("error");
 for(const bad of ["ftp://example.test","https://user:secret@example.test","https://example.test?token=x","https://example.test#id"]) expect(resolveConfig({apiBaseUrl:bad},writeToml(minimalToken))).toHaveProperty("error");
 expect(resolveConfig({},writeToml(minimalToken+'api_base_url="https://private.test/prefix/"'))).toMatchObject({apiBaseUrl:"https://private.test/prefix",consoleBaseUrl:"",jurisdiction:"us-east"});
});

describe("config reads on the governed hot path", () => {
  it("picks up a changed Kastra config without restarting the gateway", () => {
    const path = writeToml(`device_handle = "dh_one"\n`);
    expect(resolveConfig({}, path)).toMatchObject({ deviceToken: "dh_one" });
    writeFileSync(path, `device_handle = "dh_two"\ndefault_environment = "dev"\n`);
    expect(resolveConfig({}, path)).toMatchObject({ deviceToken: "dh_two", environment: "dev" });
  });
  it("does not re-parse a Kastra config that has not changed", () => {
    const path = writeToml(`device_handle = "dh_one"\n`);
    // A whole-second stamp so utimesSync can restore it byte-identically.
    const stamp = new Date(1_600_000_000_000);
    utimesSync(path, stamp, stamp);
    expect(resolveConfig({}, path)).toMatchObject({ deviceToken: "dh_one" });
    // Same byte length and same timestamps: indistinguishable from unchanged,
    // so a cached read must return the first value and a re-read must not.
    writeFileSync(path, `device_handle = "dh_two"\n`);
    utimesSync(path, stamp, stamp);
    expect(resolveConfig({}, path)).toMatchObject({ deviceToken: "dh_one" });
  });
});
