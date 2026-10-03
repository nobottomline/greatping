# Changelog

Source synchronization and npm publication are separate. Entries under
Unreleased are not available merely by installing npm `latest`.

## 0.2.0 — 2026-10-03

- Require Node.js 22.20 or later for new CLI builds (breaking runtime change).
- Send structured agent alerts with host, reason, chat and optional project labels
  (breaking protocol change; update the CLI and rerun `greatping setup`).
- Add `greatping test` with per-device push delivery diagnostics.
- Add project naming and visibility controls shared with the paired devices.
- Add `greatping run` to report a command's outcome while preserving its exit code.
- Add managed removal with dry-run, conflict preservation and pairing revocation.
- Expand MCP from two tools to five, with structured output and cancellation.
- Pin the hosted preview service and reject runtime server overrides; existing
  credentials are bound to their issuer.
- Honor optional finished-turn alerts in Claude SDK sessions.
- Qualify installed archives and make release retries reuse immutable assets.

Existing CLI 0.1.x clients must update for the structured-alert service. This
release continues to use the hosted preview environment. GitHub release assets
are available before npm approval; npm installation requires the staged release
to be approved by a maintainer with 2FA.

## 0.1.1 — 2026-09-27

Published preview; Node.js 20 or later, two MCP tools (`notify`, `ask_user`).
It predates managed `uninstall` and the unreleased service/runtime changes above.
See the matching [GitHub release](https://github.com/nobottomline/greatping/releases/tag/v0.1.1).

## 0.1.0 — 2026-09-27

Initial npm preview. See the matching
[GitHub release](https://github.com/nobottomline/greatping/releases/tag/v0.1.0).
