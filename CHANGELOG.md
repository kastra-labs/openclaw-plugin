# Changelog

## 0.2.0

### Safety And Compatibility Changes

- Missing device tokens now obey closed mode on both governed surfaces.
- Invalid decision/checkpoint envelopes and contradictory HTTP statuses block
  in all failure modes.
- Local HOLD deadline, cancellation, and wait failure always deny. Only a
  server-confirmed approval or expiry can allow a held action.
- Both hooks register a 600-second budget and respect shorter operator overrides.
  Evaluation, polling, cancellation, and sleeps are bounded; tool abort signals
  propagate to the HTTP client.
- Full JSON input replaces tool/message prefix truncation. Inputs above 256 KiB
  or values that cannot be represented losslessly as JSON are blocked.
- Channel and recipient context use the actual host SDK fields. Authentication
  credentials are no longer copied into the evaluation actor.
- Governed invocations require a private, durable local outcome journal. An
  unwritable journal blocks even in open mode. Provision a writable OpenClaw
  state directory before rollout.

### Testing And Operations

- Policy allow, unconfigured bypass, evaluation failure, human approval, and
  timeout allowance have distinct journal dispositions with available correlation.
- Unit/regression tests, real SDK type checking, tarball installation tests,
  real host hook tests, and a no-login loopback gateway suite replace the
  authenticated-only smoke check.
- CI covers OpenClaw 2026.6.6 and 2026.9.2 and produces explicitly built release
  artifacts. Development dependency security updates are included.

### Migration

Default evaluation failure mode remains open; use closed mode for mandatory
governance. Configure both hook budgets when supplying explicit overrides.
Rules that relied on truncated inputs may behave differently. Rules with timeout
ALLOW still work after server-confirmed expiry, but no longer release calls on
local interruption. Local outcome records are not uploaded to the Kastra console.
