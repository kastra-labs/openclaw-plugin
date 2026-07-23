# @kastra_labs/openclaw

Kastra AI governance for [OpenClaw](https://github.com/openclaw/openclaw): a
`before_tool_call` hook evaluates every tool call against your Kastra tenant
policies via `POST /v1/evaluate` — **allow**, **block** (DENY), or **hold for
human approval**. A HOLD opens an Approve/Deny popover in the Kastra Edge desktop
app; the hook waits for your decision. This governs OpenClaw the same way Kastra
governs Claude Code and Codex.

Example: a HOLD rule on `tool=exec`, command `^gog gmail send` means OpenClaw cannot
send an email until you tap **Approve** on your Mac.

## Install

```bash
openclaw plugins install npm:@kastra_labs/openclaw
```

Then raise the hook budget so holds can wait for a human (OpenClaw caps hook
runtime; without this, a pending hold falls back to the rule's on-timeout
decision after the default budget). In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "kastra": {
        "enabled": true,
        "hooks": { "timeouts": { "before_tool_call": 600000 } },
        "config": {}
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
| `failMode` | `open` | `closed` blocks all tools when Kastra is unreachable |
| `governMessages` | `false` | also evaluate outbound chat replies (latency cost) |
| `holdMaxWaitMs` | `540000` | max in-hook wait for approval (clamped ≤ 540 s) |

Note: keep OpenClaw's own exec-approvals on `allowlist`/`full` for commands you
govern through Kastra, or you'll be prompted twice for the same action.

## Known limitation

The `before_tool_call` hook only sees tool calls OpenClaw executes locally.
**Provider-executed (server-side) tools** — those the model provider runs on its
own infrastructure — never reach the hook, so Kastra cannot govern them. This is
the same blind spot the Claude Code and Codex integrations have.

## Version & docs

**v0.1.0**, published as [`@kastra_labs/openclaw`](https://www.npmjs.com/package/@kastra_labs/openclaw)
on npm. For the broader Kastra platform, start at the workspace docs index —
[`../docs/README.md`](../docs/README.md).
