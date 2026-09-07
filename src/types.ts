// Request and response types used by the Kastra evaluation and checkpoint APIs.
export type Actor = {
  email?: string;
  device?: string;
  os?: string;
  client?: string;
  session_id?: string;
};

export type EvaluateRequest = {
  environment?: string;
  jurisdiction: string;
  model: string;
  workload_type?: string;
  action?: string;
  resource?: string;
  source?: string;
  attributes?: Record<string, string>;
  actor?: Actor;
};

export type MatchedRule = {
  id: string;
  jurisdiction: string;
  model_prefix: string;
  environment?: string;
  reason: string;
  priority: number;
};

export type ExecuteResponse = {
  decision_id: string;
  decision: "ALLOW" | "DENY";
  reason: string;
  matched_rule?: MatchedRule;
};

export type HoldEnvelope = {
  decision: string;
  checkpoint_id: string;
  expires_at: string;
  on_timeout: "ALLOW" | "DENY";
  title: string;
  mqtt_topic?: string;
  server_now?: string;
};

export type CheckpointState = {
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  effective_decision?: "ALLOW" | "DENY";
  resolved_by?: string;
  title: string;
  on_timeout: string;
  expires_at: string;
};

export type ApiEnvelope<T> = { success: boolean; data?: T; error?: string };

export type Decision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string; ruleId?: string }
  | { kind: "hold"; envelope: HoldEnvelope };
