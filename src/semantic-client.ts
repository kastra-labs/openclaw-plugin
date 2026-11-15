import { createHash, randomBytes } from "node:crypto";
import { KastraAuthError, KastraClient, KastraHttpError, KastraProtocolError } from "./kastra-client.js";
import { normalizeBaseUrl } from "./urls.js";
import type { HoldEnvelope } from "./types.js";

export const SEMANTIC_VERSION = "semantic-event-v1";
export const SEMANTIC_HOST_VERSION = "2026.9.2";
export const SEMANTIC_CONTENT_BYTES = 64 * 1024;
const TRANSPORT_BYTES = 1024 * 1024;
// Sorted keys match the backend's canonical JSON contract hash.
export const SEMANTIC_CONTRACT = Object.freeze({
  complete_content: true, failure_mode: "block", host: "openclaw", host_version: SEMANTIC_HOST_VERSION,
  max_hold_seconds: 480, phases: ["before_tool_call"], timeout_seconds: 600,
});
const contractHash = createHash("sha256").update(JSON.stringify(SEMANTIC_CONTRACT)).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Registration = { id: string; maxContentBytes: number };
export type SemanticStage = "check" | "resume" | "dispatch";
export type SemanticReply = { decision: "ALLOW" | "DENY" | "HOLD"; status: string; hold?: HoldEnvelope };

export function newOperationId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KastraProtocolError();
  return value as Record<string, unknown>;
}
function date(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

// Applies to checkpoint polling too. Never follow a credential-bearing redirect
// or buffer an unbounded intermediary response on this enforcing path.
function boundedFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, redirect: "error" });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TRANSPORT_BYTES) throw new KastraProtocolError();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
}

export class SemanticClient extends KastraClient {
  private readonly semanticBase: string;
  private readonly semanticFetch: typeof fetch;
  constructor(baseUrl: string, private readonly token: string, fetchImpl: typeof fetch = fetch) {
    const safeFetch = boundedFetch(fetchImpl);
    super(baseUrl, token, safeFetch);
    this.semanticBase = normalizeBaseUrl(baseUrl);
    this.semanticFetch = safeFetch;
  }

  private async request(path: string, body: unknown, signal: AbortSignal, operationId?: string): Promise<{ status: number; data: Record<string, unknown> }> {
    signal.throwIfAborted();
    const response = await this.semanticFetch(this.semanticBase + path, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json",
        ...(operationId ? { "X-Kastra-Operation-Id": operationId } : {}) }, body: JSON.stringify(body),
    });
    signal.throwIfAborted();
    if (response.status === 401) throw new KastraAuthError();
    if (![200, 201, 202, 403].includes(response.status)) throw new KastraHttpError(response.status);
    let envelope: Record<string, unknown>;
    try { envelope = object(await response.json()); } catch { throw new KastraProtocolError(); }
    if (envelope.success !== true) throw new KastraProtocolError();
    return { status: response.status, data: object(envelope.data) };
  }

  async register(environment: string, signal: AbortSignal): Promise<Registration> {
    const { status, data } = await this.request("/v1/semantic/registrations", {
      contract_version: SEMANTIC_VERSION, kind: "agent_hook", name: "OpenClaw before_tool_call",
      ...(environment ? { environment } : {}), contract: SEMANTIC_CONTRACT,
    }, signal);
    if ((status !== 200 && status !== 201) || data.contract_version !== SEMANTIC_VERSION ||
        typeof data.registration_id !== "string" || !uuid.test(data.registration_id) ||
        typeof data.environment !== "string" || !data.environment || (environment && data.environment !== environment) ||
        !Number.isSafeInteger(data.revision) || (data.revision as number) < 1 || data.contract_hash !== contractHash ||
        !Number.isSafeInteger(data.max_content_bytes) || (data.max_content_bytes as number) < 1 || (data.max_content_bytes as number) > SEMANTIC_CONTENT_BYTES ||
        data.max_transport_bytes !== TRANSPORT_BYTES) throw new KastraProtocolError();
    return { id: data.registration_id, maxContentBytes: data.max_content_bytes as number };
  }

  async event(registration: Registration, operationId: string, stage: SemanticStage, toolName: string,
    args: unknown, signal: AbortSignal): Promise<SemanticReply> {
    const { status, data } = await this.request("/v1/semantic/check-event", {
      contract_version: SEMANTIC_VERSION, registration_id: registration.id, stage, target: "tool_arguments", tool_name: toolName,
      ...(stage === "check" ? { arguments: args } : {}),
    }, signal, operationId);
    if (data.contract_version !== SEMANTIC_VERSION || data.registration_id !== registration.id ||
        data.operation_id !== operationId || data.stage !== stage || data.result !== undefined || data.result_hash !== undefined) throw new KastraProtocolError();
    if (status === 200 && data.decision === "ALLOW" && data.status === (stage === "dispatch" ? "dispatched" : "prepared") &&
        data.hold === undefined && data.checkpoint_id === undefined) return { decision: "ALLOW", status: stage === "dispatch" ? "dispatched" : "prepared" };
    if (status === 403 && data.decision === "DENY" && (data.status === "denied" || data.status === "unknown") && data.hold === undefined) {
      return { decision: "DENY", status: data.status };
    }
    if (status !== 202 || data.decision !== "HOLD" || data.status !== "held") throw new KastraProtocolError();
    const hold = object(data.hold);
    if (typeof data.checkpoint_id !== "string" || !uuid.test(data.checkpoint_id) || hold.checkpoint_id !== data.checkpoint_id ||
        hold.decision !== "HOLD" || (hold.on_timeout !== "deny" && hold.on_timeout !== "DENY") ||
        !date(hold.server_now) || !date(hold.expires_at) || typeof hold.title !== "string" || hold.title.length > 4096 ||
        Date.parse(hold.expires_at) - Date.parse(hold.server_now) > 480000) throw new KastraProtocolError();
    return { decision: "HOLD", status: "held", hold: { decision: "HOLD", checkpoint_id: data.checkpoint_id,
      server_now: hold.server_now, expires_at: hold.expires_at, title: hold.title, on_timeout: "DENY" } };
  }
}
