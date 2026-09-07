import { constants, closeSync, fchmodSync, fsyncSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Disposition = "unconfigured" | "policy_allow" | "policy_deny" | "evaluate_error" | "protocol_error" |
  "invalid_input" | "cancelled" | "hook_deadline" | "hold_deadline" | "hold_error" |
  "hold_approved" | "hold_denied" | "hold_expired" | "hold_cancelled" | "hold_abandoned";
export type Outcome = {
  hook: "before_tool_call" | "message_sending";
  decision: "ALLOW" | "DENY";
  disposition: Disposition;
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  decisionId?: string;
  ruleId?: string;
  checkpointId?: string;
  status?: string;
  resolvedBy?: string;
  resolvedByEmail?: string;
  failMode?: "open" | "closed";
  elapsedMs?: number;
};
export type OutcomeRecorder = (outcome: Outcome) => void;

export function createOutcomeRecorder(opts: { path?: string; maxBytes?: number; archives?: number } = {}): OutcomeRecorder {
  return (outcome) => {
    const path = opts.path ?? join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "kastra", "outcomes.jsonl");
    const record: Record<string, unknown> = { version: 1, id: randomUUID(), timestamp: new Date().toISOString() };
    // An explicit allowlist prevents accidental credential, input, or error-object logging.
    for (const key of ["hook", "decision", "disposition", "toolName", "toolCallId", "runId", "sessionKey",
      "channelId", "accountId", "conversationId", "decisionId", "ruleId", "checkpointId", "status",
      "resolvedBy", "resolvedByEmail", "failMode"] as const) {
      const value = outcome[key];
      if (typeof value === "string") record[key] = value.slice(0, 512);
    }
    if (Number.isFinite(outcome.elapsedMs)) record.elapsedMs = outcome.elapsedMs;
    const line = Buffer.from(JSON.stringify(record) + "\n");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Serialize rotation across gateway processes. A stale lock fails closed.
    const lock = openSync(path + ".lock", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600);
      if (fstatSync(fd).size > 0 && fstatSync(fd).size + line.length > (opts.maxBytes ?? 4 * 1024 * 1024)) {
        closeSync(fd); fd = undefined;
        const archives = Math.max(1, Math.min(20, opts.archives ?? 4));
        for (let i = archives; i >= 1; i--) {
          try { renameSync(i === 1 ? path : path + "." + (i - 1), path + "." + i); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      }
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset);
      fsyncSync(fd);
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      closeSync(lock);
      unlinkSync(path + ".lock");
    }
  };
}
