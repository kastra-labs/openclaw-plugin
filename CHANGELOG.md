# Changelog

## 0.2.0

### Safety And Compatibility Changes

- Missing device tokens now obey closed mode on both governed surfaces.
- Invalid decision/checkpoint envelopes and contradictory HTTP statuses block
  in all failure modes.
- HOLD timeout enums accept the backend's lowercase spelling, and an absent or
  empty one means DENY as it does on every other client. Empty or missing
  optional correlation metadata does not invalidate an otherwise valid decision.
  HTTP evaluation failures follow failMode; explicit policy DENY still blocks.
- Only a decision envelope Kastra actually wrote can fail closed past failMode.
  An unexpected HTTP status or a body from a proxy or captive portal is a
  transport failure; checkpoint reads still refuse to act on one.
- Reaching the local deadline triggers one final checkpoint read, so an approval
  that lands during the wait is honored rather than discarded. If that read finds
  no decision, the rule's timeout applies only when the review itself has expired;
  a wait cut short by the host budget still denies.
- A rejected heartbeat no longer ends the wait. The heartbeat only defers the
  backend's abandonment sweep, so the checkpoint read stays the sole authority.
- Both hooks register a 600-second budget and respect shorter operator overrides.
  Evaluation, polling, cancellation, and sleeps are bounded; tool abort signals
  propagate to the HTTP client.
- Input above 256 KiB is clipped and flagged with
  `x-kastra-attr-tool-input-truncated` instead of being blocked unevaluated,
  matching the Claude Code and Codex hooks. Values JSON represents exactly —
  including `undefined` properties and `Date` — are governed; only values whose
  own serialization could show policy something the tool will not act on are
  blocked.
- Channel and recipient context use the actual host SDK fields. Authentication
  credentials are no longer copied into the evaluation actor.
- Provider names remain distinct from opaque destinations, and both hooks now
  resolve the channel identically, preferring the host's own requester channel.
  Run/tool-call correlation uses canonical turn-id/tool-use-id attributes.
  Nonempty host configuration wins; empty host config retains the legacy event
  fallback.
- Governed invocations require a private, durable local outcome journal. An
  unwritable journal blocks even in open mode. Provision a writable OpenClaw
  state directory before rollout.
- Journal writes and fsync are asynchronous and bounded. Renewable locks recover
  after crashed writers, ordinary contention is retried, and incomplete trailing
  records are repaired. A plain file left at the lock path is reclaimed once past
  the same lease rather than blocking every later call, the directory is synced
  only when its entry changes, and a blocked journal names its cause.
- The Kastra config file is re-read only when it changes, so a governed call no
  longer parses TOML on the hot path; `kastra-edge login` still takes effect
  without a restart.
- Heartbeat and cancellation failures are surfaced through safe diagnostics;
  permanent heartbeat failures deny, while transient failures can be retried.

### Testing And Operations

- Policy allow, unconfigured bypass, evaluation failure, human approval, and
  timeout allowance have distinct journal dispositions with available correlation.
- Unit/regression tests, real SDK type checking, tarball installation tests,
  real host hook tests, and a no-login loopback gateway suite replace the
  authenticated-only smoke check.
- CI covers OpenClaw 2026.6.6 and 2026.9.2 and produces explicitly built release
  artifacts. Development dependency security updates are included.
- Backend-compatible wire fixtures, delayed final reads, cross-process journal
  crash recovery, and packed-manifest/tag verification have regression coverage.

### Migration

Default evaluation failure mode remains open; use closed mode for mandatory
governance. Configure both hook budgets when supplying explicit overrides.
Rules that relied on truncated inputs may behave differently. Rules with timeout
ALLOW still work after server-confirmed expiry, but no longer release calls on
local interruption. Local outcome records are not uploaded to the Kastra console.
