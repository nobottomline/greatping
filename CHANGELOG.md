# Changelog

Source synchronization and npm publication are separate. Entries under
Unreleased are not available merely by installing npm `latest`.

## Unreleased

- Require Node.js 22.20 or later for new CLI builds (breaking runtime change).
- Add managed removal with dry-run, conflict preservation and pairing revocation.
- Expand MCP from two tools to five, with structured output and cancellation.
- Pin the hosted preview service and reject runtime server overrides; existing
  credentials are bound to their issuer.
- Honor optional finished-turn alerts in Claude SDK sessions.
- Qualify installed archives and make release retries reuse immutable assets.

The next version must document the Node requirement and service-selection
changes. Validate the final CLI behavior before promoting these entries to a
numbered release.

## 0.1.1 — 2026-09-27

Published preview; Node.js 20 or later, two MCP tools (`notify`, `ask_user`).
It predates managed `uninstall` and the unreleased service/runtime changes above.
See the matching [GitHub release](https://github.com/nobottomline/greatping/releases/tag/v0.1.1).

## 0.1.0 — 2026-09-27

Initial npm preview. See the matching
[GitHub release](https://github.com/nobottomline/greatping/releases/tag/v0.1.0).
