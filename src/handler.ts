import { buildEvaluateRequest, type HookCtx, type HookEvent } from "./attributes.js";
import { kastraEdgeConfigPath, resolveConfig, type ResolvedConfig } from "./config.js";
import { clearHold as defaultClearHold, notifyHold as defaultNotifyHold } from "./daemon-notify.js";
import { waitForCheckpoint, type HoldWaitOpts } from "./hold.js";
import { KastraAuthError, KastraClient } from "./kastra-client.js";

export type BeforeToolCallResult = { block: true; blockReason: string } | undefined;

export type HandlerDeps = {
  edgeConfigPath?: string;
  makeClient?: (cfg: ResolvedConfig) => Pick<KastraClient, "evaluate" | "getCheckpoint" | "heartbeat" | "cancel">;
  notifyHold?: typeof defaultNotifyHold;
  clearHold?: typeof defaultClearHold;
  holdWaitOpts?: HoldWaitOpts;
  log?: (msg: string) => void;
};

type HookEventWithContext = HookEvent & { context?: { pluginConfig?: Record<string, unknown> } };

export function createBeforeToolCallHandler(deps: HandlerDeps = {}) {
  const log = deps.log ?? ((m: string) => console.warn(`[kastra] ${m}`));
  const edgeConfigPath = deps.edgeConfigPath ?? kastraEdgeConfigPath();
  const makeClient = deps.makeClient ?? ((cfg: ResolvedConfig) => new KastraClient(cfg.apiBaseUrl, cfg.deviceToken));
  const sendHold = deps.notifyHold ?? defaultNotifyHold;
  const dropHold = deps.clearHold ?? defaultClearHold;

  return async function beforeToolCall(event: HookEventWithContext, ctx?: HookCtx): Promise<BeforeToolCallResult> {
    const cfg = resolveConfig(event.context?.pluginConfig, edgeConfigPath);
    if ("error" in cfg) {
      log(cfg.error);
      return undefined; // unconfigured = ungoverned; never brick the gateway
    }
    try {
      const client = makeClient(cfg);
      const decision = await client.evaluate(buildEvaluateRequest(event, ctx, cfg));

      if (decision.kind === "allow") return undefined;

      if (decision.kind === "deny") {
        return { block: true, blockReason: `Kastra policy denied this action: ${decision.reason}` };
      }

      // HOLD — mirror kastrahook: notify the local popover (best-effort),
      // then wait for the human to approve/deny in the Kastra console/popover.
      const env = decision.envelope;
      const consoleUrl = cfg.consoleBaseUrl ? `${cfg.consoleBaseUrl}/checkpoints?focus=${env.checkpoint_id}` : "";
      void sendHold({
        checkpoint_id: env.checkpoint_id,
        title: env.title,
        source: "openclaw",
        console_url: consoleUrl,
        expires_at: env.expires_at,
      });
      const result = await waitForCheckpoint(client, env, { maxWaitMs: cfg.holdMaxWaitMs, ...deps.holdWaitOpts });
      void dropHold(env.checkpoint_id);

      if (result.decision === "ALLOW") return undefined;
      return {
        block: true,
        blockReason: `Kastra hold "${env.title}" was ${result.resolvedBy ? `denied by ${result.resolvedBy}` : "not approved in time"}`,
      };
    } catch (err) {
      log(err instanceof KastraAuthError ? err.message : `evaluate failed: ${String(err)}`);
      if (cfg.failMode === "closed") {
        return { block: true, blockReason: "Kastra is unreachable and failMode=closed" };
      }
      return undefined; // fail-open, mirrors kastrahook MVP behavior
    }
  };
}
