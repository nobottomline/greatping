# GreatPing CLI

> **Preview.** GreatPing is in active development. The mobile app is in private testing and not yet in the App Store or Google Play, so pairing a computer needs an invitation to the test. Commands, the service address and data may change without notice until the first stable release.

Get an alert on your phone or tablet when a coding agent on this computer needs you. Requires Node.js 20 or later and the GreatPing app.

```bash
npm install -g greatping
greatping login              # pair this computer (QR code or typed code)
greatping setup              # alerts, skill and tools for Claude Code and Codex
greatping status             # pairing, devices, pause, agents (--json available)
greatping doctor [--fix]     # check (and repair) pairing, hooks and tools
greatping pause 2h           # silence this computer on every device; resume with `greatping resume`
greatping ask "Continue?" --choices Yes,No --timeout 5m
greatping notify "Build complete" --title CI
greatping mcp                # five agent tools over MCP stdio
greatping uninstall --dry-run # preview removal without changes
greatping uninstall          # confirm and remove GreatPing
greatping logout
```

From a checkout, build with `pnpm -F greatping build` and run `node apps/cli/dist/index.js <command>`.

Every command has `--help`. `login` names the computer as the OS does (for example "Alex's MacBook Pro"; override with `--name`), prints a QR code and a manual code, and waits with a countdown. When Claude Code or Codex is installed but not alerting yet, an interactive `login` offers `setup`; non-interactive runs only print the hint and never change another tool's settings. The CLI saves its bearer credential under `~/.config/greatping/config.json` on macOS/Linux or `%APPDATA%\greatping\config.json` on Windows with user-only permissions.

## Output contract

- stdout carries only results: the `ask` answer, `--json` objects, `--version`. Messages, spinners and prompts go to stderr, so `answer=$(greatping ask …)` works.
- Color is used sparingly and follows `NO_COLOR`, `FORCE_COLOR` and `--no-color`; it is off when stderr is not a terminal. Spinners and prompts appear only when stdin and stderr are terminals and `CI` is unset.
- The terminal QR code is drawn with background colors, dark on white, so it scans on light and dark themes; without color it falls back to half blocks.
- Exit codes: `0` success, `1` error (including "not paired" for `status`), `2` the question or pairing code ended without an answer (expired, cancelled or resolved), `130`/`143` interrupted. On those signals `ask` withdraws the question from the phone.
- `ask` waits on a WebSocket and checks the HTTP state after disconnects, so an answer that arrives before the connection is still observed.

After `login`, `status`, `setup` and `doctor`, and at most hourly from hooks, the CLI reports its OS name and version, CPU architecture, CLI version and, per agent (Claude Code, Codex), whether its hooks work, whether they also alert on finished turns, whether the MCP tools and skill are installed, and when a hook last ran. Devices show this under Agents. It never sends user names, paths, addresses or hardware identifiers. A computer cannot rename itself or change which devices it alerts; that is done in the app. It can pause its own alerts.

## Agents

`greatping setup` opens an interactive picker for detected agents (`setup claude`
or `setup codex` selects one). Up/Down moves, Enter or Space toggles, and Enter on
**Continue** saves. Enabled circles are green; disabled circles are dim. Escape
cancels without writes; Ctrl+C returns 130. Choices reflect installed settings;
all-off choices persist and unrelated agent hooks are preserved.

After saving alerts and tools, a separate question offers skill setup or **Skip
for now**. Choosing setup hands agent selection, installation method and final
confirmation to `npx skills@1.7.0 add nobottomline/greatping --skill greatping --global`.
The runner version is pinned for reproducible installation and removal.
Skipping leaves existing skills installed; `--no-skill` skips this step entirely.
The step also appears when alert settings are already up to date. npm's runner
fetch is accepted automatically; the skills installer keeps its own prompts.
It uses the npm/Node runtime on PATH (the current skills runner requires Node.js
22.20 or later). Its output goes to stderr, keeping GreatPing's stdout contract.
A failed skill installation leaves saved alert settings intact and provides a
retry command. `setup --yes` retains the existing bundled, offline skill install
for scripts and does not run npx.

Agent behavior:

- **Claude Code**: hooks alert when it asks a question, needs a permission (not when auto mode decides) or an MCP server asks for input, and resolve the alert when the prompt closes, the user types, or the turn ends. `--finished` also alerts when a CLI or SDK turn finishes.
- **Codex**: hooks alert when it finishes a turn and waits for you, and resolve when you reply. Codex runs new hooks only after you trust them in `/hooks`. `setup` also registers the MCP tools through `codex mcp add`, because the Codex sandbox usually blocks network access for shell commands.
- **Both**: the GreatPing skill (`skills/greatping/SKILL.md`, also installable with `npx skills add nobottomline/greatping`), so "ping me when the deploy is done" or "no pings for an hour" work in plain words.

Alerts are generic: nothing from a prompt leaves the computer, and GreatPing never answers a prompt. Attention hooks run in the background and fail silently. Stop and SessionEnd hooks finish before host teardown with bounded network timeouts. An alert waits for the computer's presence delay (30 s by default, set in the app) unless nobody has used the computer for two minutes, so a prompt answered at the keyboard never reaches your devices. `GREATPING_DISABLE=1` silences hooks for one shell or session. `setup --remove` removes agent integrations while keeping this computer paired; `hooks install|uninstall [claude|codex]` manages only the hooks.

`greatping doctor` runs each installed hook with a test event and reports broken, outdated (from an older CLI or tied to one Node version) or never-run hooks; `--fix` repairs them.

## MCP tools

`greatping mcp` starts a local stdio server using this computer's credential;
`setup codex` registers it. Prefer these tools when the agent sandbox has no
network access. CLI and MCP share the same operations and validation.

| Tool | Inputs | Result |
|---|---|---|
| `notify` | Optional `message`, `title` | `requestId`, `status: accepted` or `paused` |
| `ask_user` | `question`, optional `choices`, `timeoutSeconds` (10–86400; default 1800) | `requestId`, `status`, `paused`, optional `answer` |
| `get_status` | None | `paired`, `connection`, `alertsPausedUntil`, `deviceCount`, `integrations` |
| `pause_alerts` | `durationSeconds` (60–604800; default 3600) | `alertsPausedUntil` |
| `resume_alerts` | None | `alertsPausedUntil: null` |

Results include both text and structured content with output schemas. Operation
errors return `isError: true` and `{status: "error", code, message}`. Invalid input
is rejected by MCP before the operation runs. The tools declare read-only and
idempotency annotations; those are client hints, not authorization.

`accepted` confirms server acceptance, not phone delivery. `paused` means the
request is listed in the app without a push. Questions distinguish `answered`,
`expired`, `cancelled` and `resolved`. Cancelling a running question withdraws it
when its ID is available; failed withdrawal is an error, never a claim of success.
The WebSocket is closed and the polling loop stops on cancellation.

`get_status` is read only: it does not refresh the machine report, modify files,
send alerts, or expose the credential, account ID, machine name or device names.
Connections are `unpaired`, `connected`, `revoked`, or `unreachable`; pause and
device count are unknown (`null`) when the service cannot be checked.

Use pause/resume only at the user's request. Installed hooks already alert for
native questions and permissions: do not duplicate them with `notify`.
`ask_user` is a separate phone question and cannot approve a native host prompt.
Pairing, installation, repair and removal stay in the CLI.

`greatping notify --json` returns the same notice result. `greatping ask --json`
keeps `requestId` and `answer` and adds `status` and `paused`; terminal states
without an answer also have a JSON result. Commas work inside MCP choice strings;
the CLI's `--choices` remains a comma-separated list.

## Removal

```sh
greatping uninstall --dry-run         # inspect; no writes, network or managers
greatping uninstall                   # show the plan and ask for confirmation
greatping uninstall --yes --json      # confirmed automation; structured report
```

Full removal cleans detected GreatPing hooks, user-level MCP registrations,
bundled skills, global skills installed from `nobottomline/greatping` through
`npx skills`, unchanged recorded backups, and GreatPing's credential and local
state. It revokes the computer on the server. Account deletion is a separate
operation in the app. Existing host sessions may retain loaded hooks or MCP
connections; restart them after removing their integration.

A CLI running from a verified global npm installation is removed with
`npm uninstall --global greatping --ignore-scripts` at the end. The active npm
global root must match the running package. Checkouts, linked development
packages and unverified package-manager installations are preserved; use their
original manager to remove the package. No source checkout is deleted.

Setup records owned components in `installation.json` under GreatPing's config
directory. The journal contains paths, invocation identities and hashes, never
credential contents or original settings. Removal rereads host settings, edits
only GreatPing entries, preserves foreign entries, and never restores an old
backup over newer settings. Modified skills or backups and unknown ownership
are reported and preserved. A legacy bundled skill is removable only when its
content matches a known release and contains no added files. Legacy unjournaled
backups are preserved. Global skills are removed through the pinned skills
manager so its links and lock records stay consistent; shared skills may remain
when removing setup for only one agent.

Partial failures return exit code 1 and individual results. The credential,
journal and runtime state are retained until integration cleanup, revocation
and backup removal have succeeded, allowing a retry. Completed steps are safe
to repeat. Local cleanup failures prevent package removal; package removal
failures are also reported rather than hidden.

If the service is unavailable, retry later. To explicitly remove local data
without server revocation, use `greatping uninstall --local-only`; its warning
and JSON result identify the skipped revocation. Unpair the computer separately
in the app. `--dry-run` never invokes a package manager or the API.

`greatping setup [claude|codex] --remove` removes integrations only, keeping
pairing and the CLI. `greatping logout` unpairs without removing integrations.
Both commands are distinct from full uninstall.

## Future integration packages

Native plugin packaging will use root `plugins/{claude,codex,cursor}` and separate
`packages/opencode-plugin` and `packages/pi-extension` packages in the public
repository. CLI and MCP remain in `apps/cli`. Extract shared client code when
these adapters need it, retaining one source for operations and one active owner
for each host integration. These packages are planned, not implemented yet.

## Service and preview access

The CLI connects automatically to the GreatPing service. There is no server URL
option or environment override. The current release uses the same development
service as the mobile preview; switching to the production domain is a separate,
coordinated release. Install the private-test mobile app before running `login`.
The app is not yet available in the App Store or Google Play.

An existing pairing keeps its credential bound to the server that issued it.
Credentials from another or unknown environment are rejected locally; they are
never silently sent to this release's service. Run `logout`, then `login` to pair
again when moving between environments. Editing the saved server cannot redirect
a credential to an arbitrary host, and HTTP redirects are refused.

The service address is public information, not a credential. Access to account
data and sending alerts require individual, revocable device or computer tokens.
An installed CLI does not grant access to another account. The service and mobile
apps are not included in this open-source distribution. Set `GREATPING_DEBUG=1`
to print unexpected-error stack traces.

## CLI verification

Run `pnpm -F greatping typecheck`, `pnpm -F greatping test` (Node.js 24 for the
source loader), `pnpm -F greatping build`, and `pnpm -F greatping test:interactive`
(Python 3 on macOS/Linux). The PTY smoke suite exercises the built executable in
an isolated temporary home, including Enter/Continue, color, cancel/signals,
repeat setup, a narrow terminal, all-off preferences and the npx handoff. Its
Codex and npx fixtures never contact the hosted service or install real skills.
CI runs the bundled PTY suite on Node.js 20 and the source tests on Node.js 24.
