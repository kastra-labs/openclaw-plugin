import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { abortable, delay } from "./abort.js";

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
  heartbeatFailures?: number;
  heartbeatStatus?: number;
  cancelFailed?: boolean;
};
export type OutcomeRecorder = (outcome: Outcome, signal?: AbortSignal) => void | Promise<void>;

// One lease policy for every writer; changing it independently is unsafe.
const LOCK_STALE_MS = 10_000;
const queues = new Map<string, Promise<void>>();

function serializeOutcome(outcome: Outcome): Buffer {
  const record: Record<string, unknown> = { version: 1, id: randomUUID(), timestamp: new Date().toISOString() };
  // An explicit allowlist prevents accidental credential, input, or error-object logging.
  for (const key of ["hook", "decision", "disposition", "toolName", "toolCallId", "runId", "sessionKey",
    "channelId", "accountId", "conversationId", "decisionId", "ruleId", "checkpointId", "status",
    "resolvedBy", "resolvedByEmail", "failMode"] as const) {
    const value = outcome[key];
    if (typeof value === "string") record[key] = value.slice(0, 512);
  }
  for (const key of ["elapsedMs", "heartbeatFailures", "heartbeatStatus"] as const) {
    if (Number.isFinite(outcome[key])) record[key] = outcome[key];
  }
  if (outcome.cancelFailed === true) record.cancelFailed = true;
  return Buffer.from(JSON.stringify(record) + "\n");
}

async function repairTail(file: FileHandle): Promise<number> {
  const { size } = await file.stat();
  if (!size) return 0;
  const last = Buffer.alloc(1);
  await file.read(last, 0, 1, size - 1);
  if (last[0] === 10) return size;
  // A terminated line is the commit unit. A killed writer can leave a prefix.
  const bytes = await file.readFile();
  const end = bytes.lastIndexOf(10) + 1;
  await file.truncate(end);
  return end;
}

// The lock is a directory, so a plain file at that path is not a lock any
// writer could be holding — it is debris from an older build or an interrupted
// tool. Left in place it denies every governed call forever, since the reclaim
// path only knows how to rmdir. Reclaim it under the same lease directories
// get: recent debris still fails the call, so this can never race a writer we
// simply do not recognize.
async function reclaimNonDirectoryLock(path: string, error: unknown): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOTDIR" && code !== "EEXIST" && code !== "EPERM") return false;
  const lock = path + ".lock";
  try {
    const info = await stat(lock);
    if (info.isDirectory() || Date.now() - info.mtimeMs < LOCK_STALE_MS) return false;
    await unlink(lock);
    return true;
  } catch { return false; }
}

export function createOutcomeRecorder(opts: { path?: string; maxBytes?: number; archives?: number; timeoutMs?: number } = {}): OutcomeRecorder {
  return async (outcome, callerSignal) => {
    const path = resolve(opts.path ?? join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "kastra", "outcomes.jsonl"));
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("Outcome journal deadline exceeded")), opts.timeoutMs ?? 1000);
    const previous = queues.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let release: (() => Promise<void>) | undefined;
      let compromised: Error | undefined;
      let file: FileHandle | undefined;
      const check = () => { signal.throwIfAborted(); if (compromised) throw compromised; };
      try {
        while (!release) {
          check();
          try {
            release = await lockfile.lock(path, { realpath: false, retries: 0, stale: LOCK_STALE_MS, update: 2000,
              onCompromised: error => { compromised = error; } });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ELOCKED" && !(await reclaimNonDirectoryLock(path, error))) throw error;
            await delay(20, signal);
          }
        }
        check();
        file = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        await file.chmod(0o600);
        let size = await repairTail(file);
        // The directory entry only changes when this file is created or
        // replaced by a rotation; syncing it on every append is a second
        // durable barrier per governed call that records nothing new.
        let entryChanged = size === 0;
        const line = serializeOutcome(outcome);
        check();
        if (size > 0 && size + line.length > (opts.maxBytes ?? 4 * 1024 * 1024)) {
          await file.close(); file = undefined;
          const archives = Math.max(1, Math.min(20, opts.archives ?? 4));
          // No cancellation check between renames: the ring shifts as a unit or
          // the next rotation reads a hole as ENOENT and drops an extra
          // generation of history. The whole loop is bounded local renames.
          for (let i = archives; i >= 1; i--) {
            try { await rename(i === 1 ? path : path + "." + (i - 1), path + "." + i); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          file = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
          size = 0;
          entryChanged = true;
        }
        check();
        try {
          await file.writeFile(line);
          await file.sync();
          if (entryChanged) {
            const directory = await open(dirname(path), constants.O_RDONLY);
            try { await directory.sync(); } finally { await directory.close(); }
          }
          check();
        } catch (error) {
          // Do not leave a late ALLOW after the caller has already blocked.
          if (!compromised) { await file.truncate(size); await file.sync(); }
          throw error;
        }
      } finally {
        try { await file?.close(); }
        finally { if (release && !compromised) await release(); }
      }
    });
    queues.set(path, task);
    void task.finally(() => { if (queues.get(path) === task) queues.delete(path); }).catch(() => {});
    try { await abortable(task, signal); }
    finally { clearTimeout(timer); }
  };
}
