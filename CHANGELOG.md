# Changelog

Source synchronization and npm publication are separate. Entries under
Unreleased are not available merely by installing npm `latest`.

## 0.3.2 — 2026-10-04

- Apply project-name visibility changes made on a device from the computer's
  next alert, using the service's current preference in successful responses.
- Keep the hourly computer report on its own clock so frequent agent hooks
  do not indefinitely postpone preference and integration refreshes.

## 0.3.1 — 2026-10-04

- Check npm explicitly with `greatping update --check`, including JSON output
  and honest offline failures. Automatic checks refresh hourly; terminal
  startup/help/version briefly await a pending lookup and show notices on stderr.
- Use saved pairing state for the startup hint instead of always suggesting login.
- Detect the running installation for update instructions, diagnostics and
  removal: npm prefixes, Vite+, pnpm globals, Yarn Classic, Bun and Volta.
  Preserve custom/unverified installations and source checkouts.
- Use the stable Vite+ shim for hooks and MCP even when its Node runtime
  shadows that shim in a child process's PATH.
- Verify package ownership before revoking pairing or deleting local state;
  retain the ownership journal when package removal fails.

## 0.3.0 — 2026-10-04

- Pair computers through CPace with explicit key confirmation. Verify and pin
  the account's signed membership manifest before retaining a pairing.
- Store computer signing and encryption keys alongside the pairing credential;
  verify subsequent manifest versions and report the version in use.
- Show sending progress for `notify` and clear it before acceptance, pause,
  errors or interruption. Preserve clean JSON and non-interactive output.
- Keep the service address out of normal command output and connection errors;
  expose it through `doctor --verbose` and retain `status --json` compatibility.

This preview requires the matching device-key Worker and mobile update. CLI
0.2.x and apps without keys cannot create new pairings after the service update.
Existing paired computers can keep sending alerts; development accounts without
keys must start over in the updated app and pair their computers again. Content
encryption and signed answers are later phases and are not part of this release.

## 0.2.2 — 2026-10-03

- Clear the waiting indicator before printing an answer or final status; keep
  narrow terminals, resized windows and interrupted questions readable.
- Check npm for newer stable CLI versions in the background and show a short
  update notice after interactive commands. Cache checks, fail silently offline,
  and support `--no-update-check` and `NO_UPDATE_NOTIFIER=1`.
- Keep JSON output free of spinners and skip update checks for automation,
  redirected output, version commands and uninstall.

## 0.2.1 — 2026-10-03

- Let questions with choices also accept the user's own words, through the
  `--allow-text` flag of `greatping ask` and the `allowText` field of MCP
  `ask_user` (default true; pass false when the answer must be one of the
  choices). The phone then offers a Reply field next to Yes and No, or alone
  next to other choices.
- Send the CLI version with every service call, so an unsupported client gets a
  clear update message.

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
