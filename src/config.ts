import { parse } from "smol-toml";
import { normalizeBaseUrl } from "./urls.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ResolvedConfig = {
  apiBaseUrl: string;
  deviceToken: string;
  environment: string;
  jurisdiction: string;
  userEmail: string;
  consoleBaseUrl: string;
  consoleWarning?: string;
  failMode: "open" | "closed";
  governMessages: boolean;
  holdMaxWaitMs: number;
};

export const DEFAULT_API_BASE_URL = "https://api.kastra.ai";
export const DEFAULT_JURISDICTION = "us-east"; // default policy jurisdiction for Edge-compatible configuration
// Must stay under OpenClaw's 600 000 ms hook-budget cap, or the hook runner
// aborts the handler and the tool call proceeds ungoverned (fail-open).
export const DEFAULT_HOLD_MAX_WAIT_MS = 540_000;

export function kastraEdgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KASTRA_CONFIG && env.KASTRA_EDGE_CONFIG && resolve(env.KASTRA_CONFIG) !== resolve(env.KASTRA_EDGE_CONFIG)) {
    throw new Error("KASTRA_CONFIG and KASTRA_EDGE_CONFIG refer to different files; set only KASTRA_CONFIG");
  }
  if (env.KASTRA_CONFIG) return env.KASTRA_CONFIG;
  if (env.KASTRA_EDGE_CONFIG) return env.KASTRA_EDGE_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "kastra", "config.toml");
  return join(homedir(), ".kastra", "config.toml");
}

const EDGE_KEYS = [
  "device_handle",
  "api_base_url",
  "default_environment",
  "default_jurisdiction",
  "user_email",
  "admin_console_url",
  "console_base_url",
] as const;

// Read only top-level string keys with a real TOML parser. Missing files mean
// no local login; malformed/unreadable files are explicit errors, not defaults.
export function readEdgeConfig(path: string): Record<string, string> {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let parsed: Record<string, unknown>;
  try { parsed = parse(text); }
  catch { throw new Error("Malformed TOML in Kastra config; correct its syntax before restarting"); }
  const out: Record<string, string> = {};
  for (const key of EDGE_KEYS) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] !== "string") throw new Error(`Kastra config ${key} must be a string`);
    out[key] = parsed[key] as string;
  }
  return out;
}

// Config is static for the lifetime of the process; memoization is
// deliberately deferred until there is a measured need for it.
export function resolveConfig(
  pluginConfig: Record<string, unknown> | undefined,
  /** @internal Test seam — omit in production; defaults to the standard edge config path. */
  edgeConfigPath?: string,
): ResolvedConfig | { error: string; failMode?: "open" | "closed" } {
  const pc = pluginConfig ?? {};
  let edge: Record<string, string>;
  let apiBaseUrl: string;
  let consoleBaseUrl = "";
  let consoleWarning: string | undefined;
  try {
    edge = readEdgeConfig(edgeConfigPath ?? kastraEdgeConfigPath());
    apiBaseUrl = normalizeBaseUrl(str(pc.apiBaseUrl) ?? edge.api_base_url ?? DEFAULT_API_BASE_URL);
    const console = str(pc.consoleBaseUrl) ?? str(edge.console_base_url) ?? edge.admin_console_url ?? "";
    if (console) {
      try { consoleBaseUrl = normalizeBaseUrl(console); }
      catch { consoleWarning = "Invalid Kastra console URL; approval links disabled. Policy evaluation remains active."; }
    }
  } catch (error) { return { error: `Kastra configuration error: ${(error as Error).message}`, failMode: pc.failMode === "closed" ? "closed" : "open" }; }
  const deviceToken = str(pc.deviceToken) ?? edge.device_handle ?? "";
  if (!deviceToken) {
    return {
      error:
        "no Kastra device token: set plugins.entries.kastra.config.deviceToken in OpenClaw config, or run `kastra-edge login` on this machine",
    };
  }
  return {
    apiBaseUrl,
    deviceToken,
    environment: str(pc.environment) ?? edge.default_environment ?? "",
    jurisdiction: str(pc.jurisdiction) ?? edge.default_jurisdiction ?? DEFAULT_JURISDICTION,
    userEmail: edge.user_email ?? "",
    consoleBaseUrl,
    consoleWarning,
    failMode: pc.failMode === "closed" ? "closed" : "open",
    governMessages: pc.governMessages === true,
    holdMaxWaitMs:
      typeof pc.holdMaxWaitMs === "number" && pc.holdMaxWaitMs > 0
        ? Math.min(pc.holdMaxWaitMs, DEFAULT_HOLD_MAX_WAIT_MS)
        : DEFAULT_HOLD_MAX_WAIT_MS,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
