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
  /** Belt-and-braces fallback: getter for `api.pluginConfig` populated by the host after registration. */
  apiPluginConfig?: () => Record<string, unknown> | undefined;
};

type HookEventWithContext = HookEvent & { context?: { pluginConfig?: Record<string, unknown> } };

export function createBeforeToolCallHandler(deps: HandlerDeps = {}) {
  const log = deps.log ?? ((m: string) => console.warn(`[kastra] ${m}`));
  const edgeConfigPath = deps.edgeConfigPath ?? kastraEdgeConfigPath();
  const makeClient = deps.makeClient ?? ((cfg: ResolvedConfig) => new KastraClient(cfg.apiBaseUrl, cfg.deviceToken));
  const sendHold = deps.notifyHold ?? defaultNotifyHold;
  const dropHold = deps.clearHold ?? defaultClearHold;
  let loggedUnconfigured = false;

  return async function beforeToolCall(event: HookEventWithContext, ctx?: HookCtx): Promise<BeforeToolCallResult> {
    const cfg = resolveConfig(event.context?.pluginConfig ?? deps.apiPluginConfig?.(), edgeConfigPath);
    if ("error" in cfg) {
      if (!loggedUnconfigured) {
        loggedUnconfigured = true;
        log(cfg.error);
      }
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
      let result;
      try {
        result = await waitForCheckpoint(client, env, { maxWaitMs: cfg.holdMaxWaitMs, ...deps.holdWaitOpts });
      } catch (err) {
        log(`hold wait failed: ${String(err)} — applying on_timeout=${env.on_timeout}`);
        result = { decision: env.on_timeout === "ALLOW" ? ("ALLOW" as const) : ("DENY" as const) };
      } finally {
        void dropHold(env.checkpoint_id);
      }

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

export function createMessageSendingHandler(deps: HandlerDeps = {}) {
  const handler = createBeforeToolCallHandler(deps);
  const edgeConfigPath = deps.edgeConfigPath ?? kastraEdgeConfigPath();
  return async function messageSending(
    event: any,
    ctx?: HookCtx & Record<string, unknown>,
  ): Promise<{ cancel: true; cancelReason: string } | undefined> {
    const cfg = resolveConfig(event?.context?.pluginConfig ?? deps.apiPluginConfig?.(), edgeConfigPath);
    if ("error" in cfg || !cfg.governMessages) return undefined;
    const result = await handler(
      {
        toolName: "openclaw_message",
        params: {
          content: String(event?.content ?? "").slice(0, 2000),
          channel: String((ctx as any)?.messageProvider ?? ""),
        },
        context: event?.context,
      },
      ctx,
    );
    if (result?.block) return { cancel: true, cancelReason: result.blockReason };
    return undefined;
  };
}
