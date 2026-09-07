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
on npm. See [Kastra documentation](https://kastra.ai/docs) for setup and platform
guides.

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
`console_base_url` only (`admin_console_url` is the admin console and is never
used for approval links); neither is inferred from a custom API host. Links use `/approvals?checkpoint=<escaped-id>`.
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
