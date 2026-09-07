# @kastra_labs/openclaw

Kastra AI governance for [OpenClaw](https://github.com/openclaw/openclaw): a
`before_tool_call` hook evaluates every tool call against your Kastra tenant
policies via `POST /v1/evaluate` — **allow**, **block** (DENY), or **hold for
human approval**. A HOLD opens an Approve/Deny popover in the Kastra Edge desktop
app; the hook waits for your decision. This governs OpenClaw the same way Kastra
governs Claude Code and Codex.

Example: a HOLD rule on `tool=exec`, command `^gog gmail send`, with timeout
DENY requires approval before sending. A rule with timeout ALLOW may also release
the call after the server confirms expiry; that outcome is recorded separately.

## Install

```bash
openclaw plugins install npm:@kastra_labs/openclaw
```

The plugin registers a 600-second budget for both hooks. Explicit OpenClaw
per-hook or plugin-wide overrides take precedence, and the plugin reserves time
inside that effective budget for cleanup and recording. Example configuration
in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "kastra": {
        "enabled": true,
        "hooks": { "timeouts": { "before_tool_call": 600000, "message_sending": 600000 } },
        "config": { "failMode": "closed" }
      }
    }
  }
}
```

## Connect to Kastra

- **Same machine as kastra-edge:** nothing to do — the plugin reads
  `~/.kastra/config.toml` (run `kastra-edge login` once).
- **Remote gateway / VPS:** set `plugins.entries.kastra.config`:

```json
{
  "apiBaseUrl": "https://api.kastra.ai",
  "deviceToken": "<device handle from kastra-edge login>",
  "environment": "dev"
}
```

## Config reference

| Key | Default | Meaning |
|---|---|---|
| `apiBaseUrl` | `https://api.kastra.ai` (or TOML `api_base_url`) | Kastra backend |
| `deviceToken` | TOML `device_handle` | Bearer credential |
| `environment` | TOML `default_environment` | policy environment |
| `jurisdiction` | `us-east` (or TOML `default_jurisdiction`) | policy jurisdiction |
| `failMode` | `open` | `closed` blocks tools and enabled message governance when unconfigured or evaluation is unavailable |
| `governMessages` | `false` | also evaluate outbound chat replies (latency cost) |
| `holdMaxWaitMs` | `540000` | max in-hook wait for approval (clamped ≤ 540 s) |

Nonempty host `api.pluginConfig` is authoritative. Legacy callers may supply
`event.context.pluginConfig` only when host configuration is absent or empty.
Message governance reads that same configuration snapshot once per invocation.

Note: keep OpenClaw's own exec-approvals on `allowlist`/`full` for commands you
govern through Kastra, or you'll be prompted twice for the same action.

## Known limitation

The `before_tool_call` hook only sees tool calls OpenClaw executes locally.
**Provider-executed (server-side) tools** — those the model provider runs on its
own infrastructure — never reach the hook, so Kastra cannot govern them. This is
the same blind spot the Claude Code and Codex integrations have.

Governance also requires the plugin to be enabled and successfully loaded.
An unloaded/disabled plugin cannot block calls or write outcomes; monitor
OpenClaw's plugin diagnostics. Host/process crashes and other plugins modifying
an action after this hook are outside this plugin's enforcement boundary.
Route traffic only after OpenClaw's `/readyz` succeeds; `/healthz` is liveness,
not confirmation that startup plugins are ready. Validate plugin loading and a
known DENY policy before admitting governed traffic.

## Failure Behavior

| Outcome | Behavior |
|---|---|
| Valid policy ALLOW / DENY | Allow / block, recording decision and rule IDs when supplied |
| Missing token or invalid configuration | Follow `failMode`; record every unconfigured bypass |
| Evaluation network, authentication, HTTP 4xx/5xx, or service failure | Follow `failMode`; record `evaluate_error` (a policy DENY on HTTP 403 still blocks) |
| Malformed or contradictory API response | Block even in open mode |
| Human-approved HOLD | Allow with `hold_approved` |
| Server-confirmed expired HOLD | Apply the server's effective decision with `hold_expired` |
| Pending HOLD at a local deadline, cancellation, or wait failure | Block and attempt bounded backend cancellation; never infer timeout ALLOW locally |
| Non-JSON, lossy, or oversized input | Block even in open mode; never evaluate a truncated prefix |
| Outcome journal cannot be durably written | Block even in open mode |

Tool input and outbound message content are sent in full, up to 256 KiB of
serialized JSON. Recipient, channel, account, conversation, and thread context
are included when available. The device token is used only as the authentication
credential, not copied into the evaluation actor.

Lowercase and uppercase HOLD timeout values are accepted. Missing, null, or
empty optional correlation IDs mean unavailable metadata, not a malformed
decision. Unknown decisions, mismatched checkpoint IDs, and contradictory
status/decision combinations still block.

Inputs must be plain JSON objects/arrays and JSON primitives. Undefined property
values, Date/class instances, getters, sparse arrays, non-finite numbers,
cycles, and custom serialization are rejected, not silently omitted or converted.
Callers must normalize those values before invoking a tool; `failMode=open`
does not bypass this requirement.

`x-kastra-attr-openclaw-channel` remains the provider name, such as `slack`,
never an opaque destination ID. Tool calls resolve it from a legacy explicit
provider, a routed session, or a recognized host provider ID; otherwise it is
omitted. Message hooks supply the provider directly. Generic tool sessions may
not identify a provider, so policies requiring it should handle missing context.
Run and tool-call IDs use `x-kastra-attr-turn-id` and `x-kastra-attr-tool-use-id`.
Message account/conversation IDs are included in the JSON tool input and local
journal, not separate OpenClaw-only policy keys. Shared attribute names do not
normalize tool names or provider-specific argument schemas across clients.

## Outcome Journal

Every governed invocation writes one JSON line to
`<OpenClaw state directory>/kastra/outcomes.jsonl` before returning. This is
normally `~/.openclaw/kastra/outcomes.jsonl`; OpenClaw profiles and
`OPENCLAW_STATE_DIR` are respected. Disabled message governance produces no record.

Records contain a unique ID, timestamp, hook, effective `decision`, explicit
`disposition`, elapsed time, and available OpenClaw run/tool-call/session IDs.
Policy decision/rule IDs and checkpoint ID/status/resolver are retained when
provided. For example, an ALLOW can be `policy_allow`, `unconfigured`,
`evaluate_error`, `hold_approved`, or `hold_expired`. These are not interchangeable.
Heartbeat failures retain a count and available HTTP status; failed cancellation
sets `cancelFailed`. Both produce static operator warnings without error bodies.
Heartbeat authentication/permanent HTTP failures stop the HOLD; transient
failures remain observable while checkpoint polling continues.

The journal excludes tool arguments, message bodies, device credentials, and
arbitrary exception text. It can contain session/channel identifiers and resolver
email addresses: treat it as private audit data. Files are mode 0600 and fsynced
before authorization; four rotated archives of up to 4 MiB each are retained
beside the current file. Export them before rotation when longer retention is
needed.

This is a **local governance-outcome journal**, not proof that the tool executed,
a tamper-evident ledger, or automatic ingestion into the Kastra console.
Correlate its decision/checkpoint IDs with server records and its run/tool-call
IDs with OpenClaw execution records. Missing server IDs alone do not identify a
fail-open bypass: a valid backend decision can also lack audit metadata.

Filesystem writes, fsync, and rotation run asynchronously. Authorization waits
for completion within one second or the remaining hook budget, whichever is
shorter; an unavailable journal fails closed with a static warning. Writes are
queued locally and serialized across processes with a renewable directory lock.
A crashed writer's lock is recoverable after ten seconds without renewal;
calls during that lease may block, but later calls recover automatically.
An interrupted final JSON line is discarded under the lock before appending.
Use a local state filesystem, and do not manually remove a live lock. A legacy
pre-release regular-file lock has no owner information and cannot be safely
reclaimed: stop all gateways sharing the directory before removing that file.

## Development And Tests

Node 22 or newer is required. No Edge login, LLM key, Docker, or live Kastra tenant
is needed for these tests:

```bash
npm ci
npm run check
npm run test:integration
```

`npm run check` type-checks against the real OpenClaw SDK and runs the failure
matrix, input, wire-validation, cancellation, configuration, IPC, and durable
journal tests. `npm run test:integration` builds and packs the plugin, installs
the tarball into a fresh temporary directory, and exercises:

- The actual OpenClaw loader, tool wrapper, and outbound-message hook runner.
- A local fake Kastra HTTP API with synthetic backend-compatible lowercase HOLD
  values, empty optional IDs, HTTP failures, and contradictory responses.
- Two fresh loopback gateway starts and `/tools/invoke`, using an inert sentinel
  tool after the host's readiness check.
- Per-call journal provenance, short operator budgets, and a message HOLD longer
  than the host's default 15 seconds.
- Concurrent journal writers, rotation, and automatic recovery after killing a
  fixture lock owner with SIGKILL.

The suite isolates home/config/state, does not inherit service credentials,
and stops the gateway and removes temporary state on completion.
Dependency installation may access the public npm registry on a cold cache;
the gateway and policy fixtures do not require a live service.
It tests the packaged artifact, not an injected replacement client.
`npm run smoke` and `node scripts/smoke.mjs` run the same no-login suite.
CI tests OpenClaw **2026.6.6** and **2026.9.2**; an alternate installed host can
be tested with `npm run test:integration -- /path/to/openclaw`.
These tests verify plugin/host contracts, not the real Kastra evaluator, approval
UI, or provider-side execution.

## Version & Release

**v0.2.0** is the source version. See [CHANGELOG.md](./CHANGELOG.md) for migration
notes and [npm](https://www.npmjs.com/package/@kastra_labs/openclaw) for the
published version. Source changes do not update existing installations.
The Verified release artifact workflow builds, tests, inspects the packed
manifest, and requires its version to match the triggering `v<version>` tag.
Manual branch runs still require packed and source manifests to match. Publishing
the uploaded, verified tarball is a separate maintainer action.

`.npmrc` disables lifecycle scripts, including `prepack` and `prepublishOnly`.
Always explicitly build and test before packing; do not depend on those hooks.
See [Kastra documentation](https://kastra.ai/docs) for platform guides.

## Configuration and public interfaces

The plugin reads the same file as every Edge binary: `KASTRA_CONFIG`,
`$XDG_CONFIG_HOME/kastra/config.toml`, then `~/.kastra/config.toml`. The
pre-release `KASTRA_EDGE_CONFIG` is retired and is a configuration error
whenever it is set; a custom file never falls back to another workspace's
credentials.
TOML sections, literal strings, escapes and comments are parsed using
[smol-toml](https://github.com/squirrelchat/smol-toml). Only top-level keys apply.
Malformed files and non-string supported keys produce a logged configuration
error. The existing unconfigured/failMode behavior is preserved.

Explicit plugin options win over the file. `consoleBaseUrl` falls back to
`console_base_url`; when neither is set, the two hosted API origins derive their
console (`api.kastra.ai` → `app.kastra.ai`, `api.demo.kastra.ai` →
`demo.kastra.ai`) exactly as kastra-edge does, and a custom API host derives
nothing. `admin_console_url` is the admin console and is never used for links. Links use `/approvals?checkpoint=<escaped-id>`.
`apiBaseUrl` / `api_base_url` is a deployment root or reverse-proxy prefix,
without `/api` or `/v1`. Trailing slashes normalize; credentials, queries,
fragments and non-HTTP(S) schemes are rejected before any fetch. An existing
terminal `/v1` is not stripped: correct the config instead of doubling it.

`jurisdiction` is tenant-defined policy vocabulary. The existing `us-east`
default remains; it is not converted to `US` or validated as an ISO-only code.
`default_environment` remains a name and defaults to empty when absent.
`device_handle` is required unless `deviceToken` is supplied. `user_email`
defaults to empty. `api_base_url` defaults to `https://api.kastra.ai`.

If your `kastra-edge help` output lists `install-openclaw`, you can also install
with `kastra-edge install-openclaw --yes` or preview with `--dry-run`. If it lists
`uninstall-openclaw`, remove with `kastra-edge uninstall-openclaw --yes`.
`@kastra_labs/openclaw` is the npm package;
`kastra` remains the host plugin entry ID. These identifiers serve different
purposes and retain existing host configuration and permissions.

An invalid optional console URL disables approval links and logs a warning;
policy evaluation and the configured API failure mode remain active. Invalid API
roots and malformed credentials/configuration retain explicit error handling.
