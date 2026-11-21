import { abortable } from "./abort.js";
import { InvalidInputError, serializeInput, type HookEvent } from "./attributes.js";
import type { ResolvedConfig } from "./config.js";
import { waitForCheckpoint, type HoldWaitOpts } from "./hold.js";
import { KastraProtocolError } from "./kastra-client.js";
import type { Outcome } from "./outcomes.js";
import { SEMANTIC_TRANSPORT_BYTES, SemanticClient, newOperationId } from "./semantic-client.js";
import type { HoldEnvelope } from "./types.js";

const qualifiedHostVersions = ["2026.9.2", "2026.11.6"];

export type SemanticTransport = Pick<SemanticClient, "register" | "event" | "getCheckpoint" | "heartbeat" | "cancel">;
export type SemanticOptions = {
  hostVersion?: string; hostBudget: number; deadline: number; signal: AbortSignal;
  toolHookCount: () => number | undefined;
  makeClient?: (cfg: ResolvedConfig) => SemanticTransport;
  holdWaitOpts?: HoldWaitOpts;
  identified: (operationId: string, registrationId?: string) => void;
  held: (envelope: HoldEnvelope) => void;
  clear: (checkpointId: string) => void;
};

export async function authorizeSemanticTool(cfg: ResolvedConfig, event: HookEvent, opts: SemanticOptions): Promise<Partial<Outcome> & Pick<Outcome, "decision" | "disposition">> {
  const hostVersion = opts.hostVersion;
  if (!hostVersion || !qualifiedHostVersions.includes(hostVersion)) throw new KastraProtocolError();
  const assertHost = () => {
    opts.signal.throwIfAborted();
    // The pinned host isolates each handler's original event; priority alone
    // cannot expose another plugin's returned params. Require a sole gate.
    if (cfg.failMode !== "closed" || opts.hostBudget !== 600000 || opts.toolHookCount() !== 1) throw new KastraProtocolError();
  };
  assertHost();
  if (typeof event.toolName !== "string" || !event.toolName.trim() || event.toolName.length > 256 || /[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(event.toolName)) throw new InvalidInputError();
  const serialized = serializeInput(event.params);
  const args = JSON.parse(serialized);
  // Go's JSON decoder replaces unpaired UTF-16 surrogates. Do not classify a
  // replacement character while the native tool receives a different string.
  const inputBytes = Buffer.byteLength(JSON.stringify({ target: "tool_arguments", tool_name: event.toolName, arguments: args }, (key, value) => {
    if (/[\uD800-\uDFFF]/u.test(key) || (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value))) throw new InvalidInputError();
    return value;
  }));
  if (inputBytes > SEMANTIC_TRANSPORT_BYTES) throw new InvalidInputError();
  const operationId = newOperationId();
  opts.identified(operationId);
  const client = (opts.makeClient ?? (c => new SemanticClient(c.apiBaseUrl, c.deviceToken)))(cfg);
  const registration = await abortable(client.register(cfg.environment, hostVersion, opts.signal), opts.signal);
  opts.signal.throwIfAborted();
  opts.identified(operationId, registration.id);
  let reply = await abortable(client.event(registration, operationId, "check", event.toolName, args, opts.signal), opts.signal);
  let approval: Partial<Outcome> = {};
  while (true) {
    assertHost();
    if (reply.decision === "DENY") return { ...approval, decision: "DENY", disposition: "policy_deny", status: reply.status };
    if (reply.decision === "HOLD") {
      if (!reply.hold) throw new KastraProtocolError();
      const envelope = reply.hold;
      opts.held(envelope);
      const remaining = opts.deadline - Date.now();
      const cleanupMs = Math.max(1, Math.min(1000, remaining * 0.2));
      try {
        const result = await waitForCheckpoint(client, envelope, { ...opts.holdWaitOpts,
          maxWaitMs: Math.max(1, Math.min(480000, cfg.holdMaxWaitMs, opts.holdWaitOpts?.maxWaitMs ?? Infinity, remaining - 2 * cleanupMs)),
          cleanupMs, signal: opts.signal });
        opts.signal.throwIfAborted();
        approval = { ...result, checkpointId: envelope.checkpoint_id };
        // Never infer dispatch authority from expiration or a local deadline.
        if (result.decision !== "ALLOW" || result.status !== "approved") return { ...approval, decision: "DENY", disposition: result.disposition };
        reply = await abortable(client.event(registration, operationId, "resume", event.toolName, undefined, opts.signal), opts.signal);
      } finally { opts.clear(envelope.checkpoint_id); }
      continue;
    }
    if (reply.status === "dispatched") return { ...approval, decision: "ALLOW", disposition: approval.checkpointId ? "hold_approved" : "policy_allow", status: "dispatched" };
    if (reply.status !== "prepared") throw new KastraProtocolError();
    assertHost();
    reply = await abortable(client.event(registration, operationId, "dispatch", event.toolName, undefined, opts.signal), opts.signal);
  }
}
