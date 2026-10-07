# OpenCode and Pi native adapters

Implemented preview, 2026-10-07. Qualified on macOS with **OpenCode 1.18.34**
and **Pi 0.85.1**. The adapters are bundled in **GreatPing CLI >=0.4.0**. CLI 0.3.3 and earlier
do not contain them. Package
names below are reserved in source, not a claim of npm publication or listing.

## Install and check

The CLI carries both packages. Setup installs from those local assets, without
npm, Git downloads, provider credentials or changes to PATH:

```sh
# From a source checkout with dependencies installed:
pnpm -F greatping build
node apps/cli/dist/index.js setup opencode --yes
node apps/cli/dist/index.js setup pi --yes
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js status --json
```

Pi must be installed on PATH so setup can use its own `pi install` manager.
OpenCode files can be prepared before the host is installed. If the host is
present, setup rejects incompatible versions: OpenCode <1.18.34 or >=2, Pi
<0.85.1 or >=1. These ranges are compatibility guards, not qualification of
every subsequent version. A separate CLI capability probe rejects old GreatPing
builds even when they share the source version number.

Restart the host after setup. Pair explicitly with `greatping login` to receive
real alerts; installation never pairs a computer. Finished alerts default on;
`setup HOST --no-finished --yes` turns them off. Repeated setup preserves the
choice unless changed explicitly. `GREATPING_DISABLE=1` suppresses automatic
alerts for that process, while explicit tools remain usable.

Remove through the same owner:

```sh
node apps/cli/dist/index.js setup opencode --remove --yes
node apps/cli/dist/index.js setup pi --remove --yes
```

Restart existing sessions after removal. Pairing and plugin preferences remain.
Modified packages and entrypoints are preserved, with an actionable error.
`--migrate` applies to Claude/Codex direct integrations; native adapters already
use their own installation path. Remove a duplicate independently installed
skill through its installer rather than trying to migrate it with this flag.

## Coverage and user behavior

| Capability | OpenCode | Pi |
| --- | --- | --- |
| Finished response | One root-session `session.idle` after busy/retry; child sessions and errors are suppressed | `agent_settled`, after retries, compaction and queued continuations; failed/aborted responses are suppressed |
| Automatic question | `question.asked` → `replied`/`rejected` | Blocking extension UI prompt start/end |
| Automatic permission | `permission.asked` → `permission.replied` | No general permission signal is claimed; extension UI dialogs are covered |
| Explicit tools | Five existing CLI MCP tools, merged into the effective config | Five native `greatping_*` tools backed by the same local MCP runtime |
| Skill | Bundled canonical skill added to effective skill paths | Bundled canonical skill declared in Pi's package manifest |

Before: OpenCode/Pi users configured MCP/skills manually and relied on the model
choosing to notify them. A host's blocking question could not be reported by a
model that was itself blocked. Now: after one setup and host restart, an OpenCode
permission or question opens an attention alert automatically; answering at the
computer resolves that prompt. Pi extension dialogs behave the same way. A
successful completed response opens a finished alert, cleared on the next turn.
These alerts contain the reason and opaque session/prompt identity, not question
text, commands, answers or dialog titles. Explicit `ask_user` remains a separate
operation for intentionally sending a question to the phone.

## Architecture and ownership

Adapters observe host lifecycle and send normalized metadata through a bounded
serial queue to the installed CLI. Host event callbacks do not await delivery;
errors fail open. Each child has an eight-second deadline; shutdown flushes
within a fixed budget. Prompt IDs correlate open/close events. Pi provides no
native UI prompt ID, so the adapter generates a fresh UUID per prompt. OpenCode
tracks turn generations to reject stale asynchronous session lookups.

There is one pairing store, protocol implementation and transport: the CLI.
Pi discovers the CLI's actual MCP tool schemas, forwards calls and cancellation,
and reports failed operations as failed native tools. Neither adapter forks API,
crypto or transport logic. Extracting `packages/core` remains deferred while the
parallel E2E implementation changes those contracts; a later extraction should
be driven by measured needs rather than a second client now.

Owned packages live at `<GreatPing config>/adapters/opencode` and `adapters/pi`.
Preferences and the stable CLI launcher live at `<GreatPing config>/plugins/HOST.json`.
OpenCode gets one owned `plugins/greatping.js` entrypoint under its config home;
its JSON/JSONC is never rewritten. The plugin merges MCP and skill paths into
runtime config and preserves an existing `mcp.greatping` server. Such a server
remains user-managed and must be verified separately. Pi gets a local package
registration through `pi install`; removal uses `pi remove`. Pi resource filters
are user-managed and block automatic repair that could silently re-enable them.
Fingerprints in the CLI ownership journal prevent overwriting modified assets.

Respect `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME` and `PI_CODING_AGENT_DIR`.
Default homes follow the installed hosts: `~/.config/opencode` and `~/.pi/agent`.
Diagnostics report registration, package integrity, preferences and launcher,
plus the last observed lifecycle event. Configuration readiness is not proof
that a running host loaded the extension or that the phone received a push.
Discovery currently covers these CLI-owned installations. Independently installed
npm/Git packages and project-local duplicates are not automatically inventoried.

## Distribution

The first supported channel is the **GreatPing CLI package**, including both
native adapters. Users need no second package manager command or runtime download.
It also keeps adapter and runtime compatibility within one release artifact.

Standalone package metadata is prepared as `@greatping/opencode` (OpenCode server
plugin) and `@greatping/pi` (Pi extension/skills package). OpenCode supports local
plugins and npm entries in `plugin`; Pi supports local, npm and Git sources through
`pi install`. Pi's package gallery discovers npm packages with the `pi-package`
keyword, which our manifest includes. Publishing standalone packages requires
registry ownership, release/version policy, external-install discovery and its
own acceptance run first. Do not copy hypothetical npm installation commands
into onboarding before those steps are complete. Neither host's package install
installs GreatPing globally or edits PATH.

Claude/Codex Git marketplace catalogs remain separate. Official marketplace
acceptance and public source publication are separate delivery steps, not implied
by a local install. Keep `npx skills` for the universal skill channel and other
hosts; native adapters already carry that same skill.

## Verification and limits

```sh
pnpm plugins:check
pnpm plugins:test
pnpm plugins:test:native   # requires both installed hosts and localhost listeners
pnpm -F greatping test:package
```

Conformance tests cover event ordering, root/child/error/duplicate completion,
privacy, opt-out, missing preferences and MCP cancellation. CLI tests cover
repeatable offline setup, no-finished preferences, preserved JSONC, migration
routing and refusal to overwrite or remove edited files. Package smoke runs
against an installed tarball outside the workspace to verify bundled assets.

The real-host harness uses disposable homes, a loopback fixture model and a
recording transport that rejects unexpected GreatPing routes. It exercises both
hosts' real model loops; OpenCode native question/permission open and reply;
Pi RPC blocking UI open and close; five Pi tool registrations and actual native
status tool execution; bundled Pi skill in model context; effective OpenCode
MCP/skill configuration; repeated setup and removal preserving pairing. It uses
no real provider account, production API, existing sessions or phone.

Runtime code uses portable Node APIs and file URLs, with no shell interpolation.
Verified npm Windows launcher layouts invoke Pi's JS entrypoint or OpenCode's
packaged executable directly. Doctor also checks installed host compatibility. Actual
native-host qualification here is **macOS only**. Windows and Linux host runs,
physical phone delivery, interruption/retry behavior under live provider faults,
and marketplace/registry acceptance remain separate release gates. OpenCode 2's
plugin API is a different target and is intentionally rejected by setup.

## Primary references

- [OpenCode plugin documentation](https://opencode.ai/docs/plugins/).
- [OpenCode 1.18.34 loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/shared.ts)
  and [server event bridge](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/index.ts).
  The installed binary and this tag were inspected at commit
  `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`; this is the 1.x server module API.
- [OpenCode 2 plugin API](https://opencode.ai/v2/docs/build/plugins), a separate API.
- [Pi 0.85.1 extensions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)
  and [package discovery](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md).
  Installed docs, runtime types, examples and lifecycle emission were inspected.
- [Pi package gallery](https://pi.dev/packages).


## Environment and delivery diagnostics

Use [native alert troubleshooting](troubleshooting.md) if a prompt produces no
phone alert while explicit `notify` still works. Plugins can use a saved source
launcher different from the PATH-installed CLI. Both versions can print 0.3.3
while targeting different services. Local pairing readiness and the last alert
attempt are now reported separately from host heartbeat/configuration.
A new issuer requires a phone build for the same service and explicit re-pairing;
setup and doctor preserve existing credentials. The repeat qualification run
passed on installed OpenCode 1.18.35 and Pi 0.85.1 with fixture transport.
