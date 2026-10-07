# Native alert troubleshooting

An installed plugin, a successful no-op hook probe, a recent heartbeat and a
working shell `notify` do not prove that a native alert was accepted or delivered.
Plugins use their saved CLI launcher; the shell may resolve a different build,
even when both print the same unreleased CLI version.

## Environment mismatch after a source update

The 2026-10-07 local OpenCode investigation found a saved source-CLI launcher
and a pairing issued by the previous development service. Main now targets the
production service. The source CLI correctly refused to send that credential to
another issuer, but the fail-open hook previously swallowed the error. A local
open mark was created before transport validation, making it look as if an alert
had opened. The PATH-installed older CLI used the original service, explaining
why explicit `notify` could still work.

The hook now checks local pairing readiness before creating marks for a known
issuer mismatch. It records only an allowlisted failure category, timestamp and
outcome under `hook-state/<host>.alert.json`. Network failures retain a mark:
a timed-out create may have reached the service, so later cleanup must still be
possible. Only a successful create response records `accepted`; a closing event
does not clear the last send failure. Acceptance is not device delivery.

`doctor` shows the expected service and explicit pairing repair instructions.
Plugin checks probe the saved launcher with the local, read-only `runtime-health`
command. Setup warns when components can be installed but pairing cannot send.
MCP status exposes `pairingProblem` and plugin `lastAlert`. Hooks stay silent and
return zero so GreatPing cannot interrupt an agent. No raw errors, question text,
session IDs, credentials or server responses are written to diagnostic files.

Before re-pairing, ensure the phone build and CLI use the same service. Then run
`greatping logout` and `greatping login` using the intended CLI build. Doctor does
not migrate pairing, rewrite its issuer, or redirect existing credentials. Do not
remove a working pairing merely to make plugin checks green. Updating source does
not replace a separately installed CLI or publish its changes.

## A question closes before the presence delay

Attention alerts while at the computer wait the machine's configured presence
delay (doctor displays it). If the native question is answered or cancelled before
that delay, the matching closing event resolves it and push can be suppressed.
Explicit `notify` is a separate operation, so its delivery is not a comparison of
this behavior. Hold a native question open past the displayed delay when testing;
verify the alert attempt, API acceptance and phone display separately.

## Checks

Use the exact CLI entrypoint saved by setup:

```sh
node apps/cli/dist/index.js doctor --verbose
node apps/cli/dist/index.js status --json
pnpm plugins:test
pnpm plugins:test:native
```

The native qualification command runs installed OpenCode/Pi in disposable homes
against a loopback model and fixture transport. It exercises actual host dispatch,
opening and closing prompts, root completion, Pi UI requests and native tools,
MCP registration, bundled skills and removal. It never sends to a real phone.
The 2026-10-07 run passed on OpenCode 1.18.35 and Pi 0.85.1 on macOS. Physical
delivery and real-host runs on Windows/Linux need separate acceptance.
