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
  failMode: "open" | "closed";
  governMessages: boolean;
  holdMaxWaitMs: number;
};

export const DEFAULT_API_BASE_URL = "https://api.kastra.ai";
// Must stay under OpenClaw's 600 000 ms hook-budget cap, or the hook runner
// aborts the handler and the tool call proceeds ungoverned (fail-open).
export const DEFAULT_HOLD_MAX_WAIT_MS = 540_000;

export function kastraEdgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
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
] as const;

// Precompile one regex per key at module load.  The value pattern
// `((?:[^"\\]|\\.)*)` matches quoted TOML string values including escape
// sequences (e.g. `\"` inside a value).
const EDGE_KEY_REGEXES = new Map(
  EDGE_KEYS.map((k) => [k, new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m")]),
);

// config.toml is flat `key = "value"` pairs; extract the handful of keys we
// need without a TOML dependency.
export function readEdgeConfig(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const key of EDGE_KEYS) {
    const m = text.match(EDGE_KEY_REGEXES.get(key)!);
    // Unescape backslash sequences captured from the TOML quoted string.
    if (m) out[key] = m[1].replace(/\\(.)/g, "$1");
  }
  return out;
}

// Config is static for the lifetime of the process; memoization is
// deliberately deferred until there is a measured need for it.
export function resolveConfig(
  pluginConfig: Record<string, unknown> | undefined,
  /** @internal Test seam — omit in production; defaults to the standard edge config path. */
  edgeConfigPath: string = kastraEdgeConfigPath(),
): ResolvedConfig | { error: string } {
  const pc = pluginConfig ?? {};
  const edge = readEdgeConfig(edgeConfigPath);
  const deviceToken = str(pc.deviceToken) ?? edge.device_handle ?? "";
  if (!deviceToken) {
    return {
      error:
        "no Kastra device token: set plugins.entries.kastra.config.deviceToken in OpenClaw config, or run `kastra-edge login` on this machine",
    };
  }
  return {
    apiBaseUrl: str(pc.apiBaseUrl) ?? edge.api_base_url ?? DEFAULT_API_BASE_URL,
    deviceToken,
    environment: str(pc.environment) ?? edge.default_environment ?? "",
    jurisdiction: str(pc.jurisdiction) ?? edge.default_jurisdiction ?? "",
    userEmail: edge.user_email ?? "",
    consoleBaseUrl: str(pc.consoleBaseUrl) ?? edge.admin_console_url ?? "",
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
