import { parse } from "smol-toml";
import { derivedSaaSConsole, normalizeBaseUrl } from "./urls.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ResolvedConfig = {
  apiBaseUrl: string;
  deviceToken: string;
  environment: string;
  jurisdiction: string;
  userEmail: string;
  consoleBaseUrl: string;
  consoleWarning?: string;
  failMode: "open" | "closed";
  holdMaxWaitMs: number;
};

export const DEFAULT_API_BASE_URL = "https://api.kastra.ai";
export const DEFAULT_JURISDICTION = "us-east"; // default policy jurisdiction for Edge-compatible configuration
// Reserve time for evaluation, cancellation, and the outcome journal.
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000;
export const DEFAULT_HOLD_MAX_WAIT_MS = 540_000;

export function effectiveHookTimeout(hooks: { timeoutMs?: number; timeouts?: Record<string, number> } | undefined, hook: string): number {
  const timeout = hooks?.timeouts?.[hook] ?? hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, DEFAULT_HOOK_TIMEOUT_MS) : DEFAULT_HOOK_TIMEOUT_MS;
}

export function kastraEdgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // KASTRA_EDGE_CONFIG is retired. Ignoring it would silently send a machine
  // that still sets it to the default path (another login, or none), so its
  // presence is a configuration error even when it names the same file as
  // KASTRA_CONFIG. The handler surfaces that error once; under failMode
  // "closed" it blocks, under the default "open" the plugin does not govern
  // (the documented unconfigured contract) — the error is what makes it visible.
  if (env.KASTRA_EDGE_CONFIG) {
    throw new Error("KASTRA_EDGE_CONFIG is no longer read; set KASTRA_CONFIG instead");
  }
  if (env.KASTRA_CONFIG) return env.KASTRA_CONFIG;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "kastra", "config.toml");
  return join(homedir(), ".kastra", "config.toml");
}

const EDGE_KEYS = [
  "device_handle",
  "api_base_url",
  "default_environment",
  "default_jurisdiction",
  "user_email",
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
): ResolvedConfig | { error: string; failMode: "open" | "closed" } {
  const pc = pluginConfig ?? {};
  let edge: Record<string, string>;
  let apiBaseUrl: string;
  let consoleBaseUrl = "";
  let consoleWarning: string | undefined;
  try {
    edge = readEdgeConfig(edgeConfigPath ?? kastraEdgeConfigPath());
    apiBaseUrl = normalizeBaseUrl(str(pc.apiBaseUrl) ?? edge.api_base_url ?? DEFAULT_API_BASE_URL);
    // console_base_url is the customer console; admin_console_url names the
    // ADMIN console and is never read as the approval-link base.
    const console = str(pc.consoleBaseUrl) ?? str(edge.console_base_url) ?? derivedSaaSConsole(apiBaseUrl);
    if (console) {
      try { consoleBaseUrl = normalizeBaseUrl(console); }
      catch { consoleWarning = "Invalid Kastra console URL; approval links disabled. Policy evaluation remains active."; }
    }
  } catch (error) { return { error: `Kastra configuration error: ${(error as Error).message}`, failMode: pc.failMode === "closed" ? "closed" : "open" }; }
  const deviceToken = str(pc.deviceToken) ?? edge.device_handle ?? "";
  if (!deviceToken) {
    return {
      failMode: pc.failMode === "closed" ? "closed" : "open",
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
    holdMaxWaitMs:
      typeof pc.holdMaxWaitMs === "number" && Number.isFinite(pc.holdMaxWaitMs) && pc.holdMaxWaitMs > 0
        ? Math.min(pc.holdMaxWaitMs, DEFAULT_HOLD_MAX_WAIT_MS)
        : DEFAULT_HOLD_MAX_WAIT_MS,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
