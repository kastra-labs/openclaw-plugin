import { abortable } from "./abort.js";
import { buildEvaluateRequest, InvalidInputError, type HookCtx, type HookEvent } from "./attributes.js";
import { DEFAULT_HOOK_TIMEOUT_MS, resolveConfig, type ResolvedConfig } from "./config.js";
import { clearHold as defaultClearHold, notifyHold as defaultNotifyHold } from "./daemon-notify.js";
import { waitForCheckpoint, type HoldWaitOpts } from "./hold.js";
import { KastraClient, KastraProtocolError } from "./kastra-client.js";
import { createOutcomeRecorder, type Outcome, type OutcomeRecorder } from "./outcomes.js";
import type { MessageEvent } from "./host-types.js";

export type BeforeToolCallResult = { block: true; blockReason: string } | undefined;
export type HandlerDeps = {
  edgeConfigPath?: string;
  makeClient?: (cfg: ResolvedConfig) => Pick<KastraClient, "evaluate" | "getCheckpoint" | "heartbeat" | "cancel">;
  notifyHold?: typeof defaultNotifyHold;
  clearHold?: typeof defaultClearHold;
  holdWaitOpts?: HoldWaitOpts;
  log?: (msg: string) => void;
  apiPluginConfig?: () => Record<string, unknown> | undefined;
  hookTimeoutMs?: () => number;
  recordOutcome?: OutcomeRecorder;
};
type LegacyConfig = { context?: { pluginConfig?: Record<string, unknown> } };
type HookEventWithContext = HookEvent & LegacyConfig;

function pluginConfig(deps: HandlerDeps, event: LegacyConfig): Record<string, unknown> | undefined {
  const host = deps.apiPluginConfig?.();
  return host && Object.keys(host).length > 0 ? host : event.context?.pluginConfig ?? host;
}

function createGate(deps: HandlerDeps, hook: Outcome["hook"]) {
  const record = deps.recordOutcome ?? createOutcomeRecorder();
  let loggedUnconfigured = false;
  let loggedConsoleWarning = false;
  const log = (message: string) => { try { (deps.log ?? console.warn)(`[kastra] ${message}`); } catch { /* Logging cannot change enforcement. */ } };
  const bestEffort = (operation: () => Promise<void>) => {
    try { void operation().catch(() => log("Local approval notification unavailable")); }
    catch { log("Local approval notification unavailable"); }
  };
  return async (event: HookEventWithContext, ctx?: HookCtx, pc = pluginConfig(deps, event)): Promise<BeforeToolCallResult> => {
    const started = Date.now();
    const hostBudget = deps.hookTimeoutMs?.() ?? DEFAULT_HOOK_TIMEOUT_MS;
    const completionDeadline = started + hostBudget - Math.min(100, hostBudget / 4);
    const base: Pick<Outcome, "hook"> & Partial<Outcome> = {
      hook, toolName: event.toolName, toolCallId: ctx?.toolCallId ?? event.toolCallId,
      runId: ctx?.runId ?? event.runId, sessionKey: ctx?.sessionKey,
      channelId: ctx?.channelId, accountId: ctx?.accountId, conversationId: ctx?.conversationId,
    };
    const finish = async (outcome: Pick<Outcome, "decision" | "disposition"> & Partial<Outcome>, reason: string): Promise<BeforeToolCallResult> => {
      const remaining = completionDeadline - Date.now();
      const journal = new AbortController();
      const timer = setTimeout(() => journal.abort(), Math.max(1, Math.min(1000, remaining)));
      const signal = outcome.decision === "ALLOW" && ctx?.abortSignal ? AbortSignal.any([journal.signal, ctx.abortSignal]) : journal.signal;
      try {
        if (remaining <= 0) throw new Error("Hook completion deadline exceeded");
        signal.throwIfAborted();
        await abortable(Promise.resolve(record({ ...base, ...outcome, elapsedMs: Date.now() - started }, signal)), signal);
        signal.throwIfAborted();
      }
      catch {
        log("Outcome journal unavailable; action blocked");
        return { block: true, blockReason: "Kastra could not durably record the governance outcome" };
      }
      finally { clearTimeout(timer); }
      return outcome.decision === "DENY" ? { block: true, blockReason: reason } : undefined;
    };
    if (ctx?.abortSignal?.aborted) return finish({ decision: "DENY", disposition: "cancelled" }, "OpenClaw call cancelled");
    const cfg = resolveConfig(pc, deps.edgeConfigPath);
    base.failMode = cfg.failMode;
    if ("error" in cfg) {
      if (!loggedUnconfigured) { log("Kastra is unconfigured; check the device token and local configuration"); loggedUnconfigured = true; }
      return finish({ decision: cfg.failMode === "closed" ? "DENY" : "ALLOW", disposition: "unconfigured" }, "Kastra is unconfigured and failMode=closed");
    }
    if (cfg.consoleWarning && !loggedConsoleWarning) { log(cfg.consoleWarning); loggedConsoleWarning = true; }
    const budget = Math.max(1, hostBudget - Math.min(1000, hostBudget / 2));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    const signal = ctx?.abortSignal ? AbortSignal.any([ctx.abortSignal, controller.signal]) : controller.signal;
    const deadline = started + budget;
    let checkpointId: string | undefined;
    try {
      const request = buildEvaluateRequest(event, ctx, cfg);
      const client = (deps.makeClient ?? ((c) => new KastraClient(c.apiBaseUrl, c.deviceToken)))(cfg);
      const decision = await abortable(client.evaluate(request, Math.min(3000, budget), signal), signal);
      if (signal.aborted) throw signal.reason;
      if (decision.kind === "allow" || decision.kind === "deny") {
        return finish({
          decision: decision.kind === "allow" ? "ALLOW" : "DENY",
          disposition: decision.kind === "allow" ? "policy_allow" : "policy_deny",
          decisionId: decision.decisionId, ruleId: decision.ruleId,
        }, `Kastra policy denied this action: ${decision.reason ?? "denied"}`);
      }
      if (decision.kind !== "hold") throw new KastraProtocolError();
      const env = decision.envelope;
      checkpointId = env.checkpoint_id;
      bestEffort(() => (deps.notifyHold ?? defaultNotifyHold)({
        checkpoint_id: env.checkpoint_id, title: env.title, source: "openclaw",
        console_url: cfg.consoleBaseUrl ? `${cfg.consoleBaseUrl}/approvals?checkpoint=${encodeURIComponent(env.checkpoint_id)}` : "",
        expires_at: env.expires_at,
      }));
      const remaining = Math.max(1, deadline - Date.now());
      const cleanupMs = Math.max(1, Math.min(1000, remaining * 0.2));
      try {
        const result = await waitForCheckpoint(client, env, {
          ...deps.holdWaitOpts,
          maxWaitMs: Math.min(cfg.holdMaxWaitMs, deps.holdWaitOpts?.maxWaitMs ?? Infinity, Math.max(1, remaining - cleanupMs)),
          cleanupMs,
          signal,
        });
        if (result.heartbeatFailures) log("Checkpoint heartbeat failed during approval wait; see outcome diagnostics");
        if (result.cancelFailed) log("Checkpoint cancellation failed; action remains blocked");
        if (ctx?.abortSignal?.aborted || controller.signal.aborted) {
          return finish({ ...result, decision: "DENY", disposition: ctx?.abortSignal?.aborted ? "cancelled" : "hook_deadline", checkpointId }, "Kastra approval wait interrupted");
        }
        return finish({ ...result, checkpointId }, `Kastra hold was not approved${result.resolvedBy ? " by " + result.resolvedBy : ""}`);
      } finally {
        bestEffort(() => (deps.clearHold ?? defaultClearHold)(env.checkpoint_id));
      }
    } catch (error) {
      const disposition = ctx?.abortSignal?.aborted ? "cancelled" : controller.signal.aborted ? "hook_deadline" :
        error instanceof InvalidInputError ? "invalid_input" : error instanceof KastraProtocolError ? "protocol_error" :
          checkpointId ? "hold_error" : "evaluate_error";
      const allow = disposition === "evaluate_error" && cfg.failMode === "open";
      log(`${disposition}: action ${allow ? "allowed by failMode=open" : "blocked"}`);
      return finish({ decision: allow ? "ALLOW" : "DENY", disposition, checkpointId }, `Kastra could not authorize this action (failMode=${cfg.failMode})`);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

export function createBeforeToolCallHandler(deps: HandlerDeps = {}) {
  return createGate(deps, "before_tool_call");
}

export function createMessageSendingHandler(deps: HandlerDeps = {}) {
  const gate = createGate(deps, "message_sending");
  return async (event: MessageEvent & LegacyConfig, ctx?: HookCtx): Promise<{ cancel: true; cancelReason: string } | undefined> => {
    const pc = pluginConfig(deps, event);
    if (pc?.governMessages !== true) return undefined;
    const params: Record<string, unknown> = { content: event.content, to: event.to, channel: ctx?.channelId ?? "" };
    for (const key of ["threadId", "replyToId"] as const) if (event[key] !== undefined) params[key] = event[key];
    for (const key of ["accountId", "conversationId"] as const) if (ctx?.[key] !== undefined) params[key] = ctx[key];
    const result = await gate({ toolName: "openclaw_message", params, context: event.context },
      { ...ctx, messageProvider: ctx?.messageProvider ?? ctx?.channelId }, pc);
    return result?.block ? { cancel: true, cancelReason: result.blockReason } : undefined;
  };
}
