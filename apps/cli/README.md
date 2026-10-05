# GreatPing CLI

> **Preview.** GreatPing is in active development. The mobile app is in private testing and not yet in the App Store or Google Play, so pairing a computer needs an invitation to the test. Commands, the service address and data may change without notice until the first stable release.

Get an alert on your phone or tablet when a coding agent on this computer needs you. Requires Node.js 22.20 or later and the GreatPing app.

```bash
npm install -g greatping
greatping login              # pair this computer (QR code or typed code)
greatping setup              # alerts, skill and tools for Claude Code and Codex
greatping status             # pairing, devices, pause, agents (--json available)
greatping doctor [--fix] [--verbose] # check pairing, hooks and tools; include diagnostics
greatping pause 2h           # silence this computer on every device; resume with `greatping resume`
greatping project labels folder  # alerts name the project folder, e.g. "Codex · billing-api"
greatping project name "Client A" # call the current project something else (or: hide, reset, list)
greatping ask "Continue?" --choices Yes,No --timeout 5m  # add --allow-text to accept own words too
greatping notify "Build complete" --title CI
greatping run -- pnpm test   # run a command, get "pnpm test failed · exit 1 after 4m 12s" (--on-fail, --title)
greatping test               # test notification to every device, with Apple's or Google's answer per device
greatping mcp                # five agent tools over MCP stdio
greatping uninstall --dry-run # preview removal without changes
greatping uninstall          # confirm and remove GreatPing
greatping logout
```

From a checkout, use Node.js 24 LTS (24.11 or later), build with `pnpm -F greatping build` and run `node apps/cli/dist/index.js <command>`.

Every command has `--help`. `login` names the computer as the OS does (for example "Alex's MacBook Pro"; override with `--name`), prints a QR code and a manual code, and waits with a countdown. When Claude Code or Codex is installed but not alerting yet, an interactive `login` offers `setup`; non-interactive runs only print the hint and never change another tool's settings. The CLI saves its bearer credential under `~/.config/greatping/config.json` on macOS/Linux or `%APPDATA%\greatping\config.json` on Windows with user-only permissions.

The code has two halves, `ABCD-EFGH`. The first finds the pairing on the service; the second never leaves this computer and the phone it is typed or scanned into. The CLI and the phone run CPace (a password-authenticated key exchange) on it, so each confirms the other's keys and a service in between cannot swap them; a mistyped code makes `login` revoke itself with "The code did not match". The computer's Ed25519 and X25519 keys and the latest account manifest it verified (the signed list of the account's devices and computers) are kept in the same user-only config file. `status` shows them as Keys; a computer paired before keys shows `none` until it is paired again. Hourly reports follow the manifest, verify every new version and report the version in use, so devices notice a service that withholds changes. The protocol is in `packages/protocol/src/crypto`; `@noble/curves` and `@noble/hashes` are runtime dependencies because the bundled protocol imports them.

## Output contract

- stdout carries only results: the `ask` answer, `--json` objects, `--version`. Messages, spinners and prompts go to stderr, so `answer=$(greatping ask …)` works.
- Color is used sparingly and follows `NO_COLOR`, `FORCE_COLOR` and `--no-color`; it is off when stderr is not a terminal. Spinners and prompts appear only when stdin and stderr are terminals and `CI` is unset.
- The terminal QR code is drawn with background colors, dark on white, so it scans on light and dark themes; without color it falls back to half blocks.
- Exit codes: `0` success, `1` error (including "not paired" for `status`), `2` the question or pairing code ended without an answer (expired, cancelled or resolved), `130`/`143` interrupted. On those signals `ask` withdraws the question from the phone.
- `ask` waits on a WebSocket and checks the HTTP state after disconnects, so an answer that arrives before the connection is still observed.
- `ask` clears its waiting line before printing the answer or final status. JSON has no spinner; narrow terminals shorten the waiting label instead of wrapping it.
- `notify` immediately shows a sending indicator in interactive terminals and clears it before acceptance, a paused-alert warning or an error. JSON, redirected output, CI and dumb terminals have no animation. Interruption restores the terminal and returns `130`/`143`; check the app because an interrupted send may already have been accepted. Acceptance does not confirm delivery to a device.
- Normal command output identifies the GreatPing service without printing its address. `doctor --verbose` includes the address for troubleshooting; `status --json` retains its existing `server` field for script compatibility.

## Update notices

Run `greatping update --check` (or `greatping update`) to check npm now and see
the installed/latest versions and the update command for this installation.
`--json` returns the same information without animation or other output.
Explicit checks bypass the cache and notifier opt-out. A failed lookup exits
with `1` and reports availability as unknown; it does not claim you are current.

Interactive commands check npm's `latest` tag in a detached process, at most once
per hour. Help, bare startup and version commands can wait up to 800 ms for that
worker; other commands never wait for it. A newer stable version produces a short
notice on stderr **after** the result. `--version` keeps stdout as the version
alone; redirected version output has no notice. GreatPing never installs updates
automatically. If the background lookup finishes later, the next interactive
command shows the notice.

The check has a three-second HTTP timeout and a five-second total lifetime. A
failed automatic attempt is silent and waits at least 15 minutes before retrying. The cache
(`update-check.json` beside the CLI config) is written atomically with user-only
permissions; results older than seven days are not advertised. Only the public
package tag is requested from `registry.npmjs.org`, without pairing credentials,
npm credentials or project information. HTTP redirects are refused.

Checks and notices are disabled for redirected output, JSON, CI, dumb terminals,
hooks, MCP and uninstall. Use `--no-update-check` or
`NO_UPDATE_NOTIFIER=1` to disable them for other commands. Color settings apply to
the notice too. `uninstall` removes the update cache with the other local state.

Installation detection uses the running package and filesystem ownership evidence,
not merely the presence of a manager on PATH. It recognizes npm global prefixes,
Vite+ recorded packages and shims, pnpm global layouts, Yarn Classic globals,
Bun's global store and Volta package images. nvm/fnm/asdf-managed Node runtimes
use the owning package manager; npm update instructions pin the existing prefix
so a different runtime cannot receive the update by accident. Unknown/custom
layouts and source checkouts get a manual instruction. `doctor --verbose` shows
the detected manager, package location, stable launcher and update command.

For Vite+ installations use `vp install -g greatping@latest`. Its global store
is separate from npm's globals, even when npm itself runs through Vite+.
Hooks and MCP use the verified Vite+ shim, which survives package/Node upgrades.
Bare startup uses the saved pairing only for the next-step hint; `status` performs
the server check. A saved credential is not presented as a verified live session.

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

Alerts say who waits and why, never what about: the hook sends the agent, the reason (permission, question, input, finished) and opaque hashes of the chat session and prompt; nothing from a prompt leaves the computer, and GreatPing never answers a prompt. Attention hooks run in the background and fail silently. Stop and SessionEnd hooks finish before host teardown with bounded network timeouts. An alert waits for the computer's presence delay (30 s by default, set in the app) unless nobody has used the computer for two minutes, so a prompt answered at the keyboard never reaches your devices. `GREATPING_DISABLE=1` silences hooks for one shell or session. `setup --remove` removes agent integrations while keeping this computer paired; `hooks install|uninstall [claude|codex]` manages only the hooks.

### Long commands

`greatping run -- <command> [args…]` runs a command in the current terminal (stdin, stdout and stderr stay attached) and sends one alert when it ends: "pnpm test succeeded · Finished in 4m 12s" or "pnpm test failed · Exit code 1 after 4m 12s". The alert names the program and a plain-word subcommand only; arguments never leave the computer, since they can hold tokens or paths. `--title` names it yourself, `--on-fail` alerts only on failure. It exits with the command's code (127 when it cannot start), so it works in scripts; an interrupted command (Ctrl+C, SIGTERM) alerts nobody. A failed alert, for example when the computer is not paired, is a warning and never changes the exit code. The command is run directly, not through a shell: use `greatping run -- sh -c "…"` for pipelines.

### Test notifications

`greatping test` sends one test notification to every device of the account, the way this computer's alerts reach them (a device set to Off for it is skipped), and waits up to 30 seconds for Apple's or Google's answer. Each device is reported as accepted, still sending, not sent (Off, or notifications not set up) or refused with the push service's code and what to do: open GreatPing on the device, or report a credentials problem of the service. "Accepted" means Apple or Google took the notification for the device, which is as far as a server can know; check that it appeared. It exits 0 when at least one device was reached and prints the result as JSON with `--json`. The app has the same test per device (a device's screen › Send Test Notification).

### Project labels

`greatping project` lists the available actions and the cached computer-wide
setting. Use `greatping project show` for the current project's label, or
`greatping project --help` for command descriptions. `greatping project --json`
keeps the same settings output as `greatping project show --json` for scripts.

Alerts can name the project an agent works in: "Codex · billing-api". The label is the folder name of the git repository (or worktree) root, or a name you choose; never a path. Labels are off until you turn them on in the `setup` picker (**Projects › Show project folder names**), with `greatping project labels folder`, or on the computer's screen in the app; `hidden` turns them off and the server then drops any label. Per project, from its directory: `greatping project name "Client A"` sends that name instead (for a folder under NDA, two clones with the same name, or a generic `app` folder), `greatping project hide` sends none, `greatping project reset` returns to the computer's setting and `greatping project list` shows the overrides. Overrides and the cached mode live in `alerts.json` next to the config, with the secret that keys the opaque ids. A device can also keep project names off its Lock Screen (Settings › Project Names); the app always shows them. Labels are deleted with the alert's text 7 days after it finishes.

`greatping doctor` runs each installed hook with a test event and reports broken, outdated (from an older CLI or tied to one Node version) or never-run hooks; `--fix` repairs them.

### Advanced hook management

Use `greatping setup` for normal agent configuration. `greatping hooks` is a
supported advanced command for scripts and for changing hooks independently of
MCP tools and skills:

```sh
greatping hooks status
greatping hooks install claude --finished
greatping hooks uninstall codex
greatping hooks --help
```

Without an action, it shows the current integration status. Omit the agent to
install or remove hooks for all detected agents. `--finished` and `--no-finished`
control Claude Code's turn-end alerts; Codex hooks include turn-end alerts.
Removing hooks preserves pairing, MCP tools, skills and unrelated agent hooks.
Use `greatping doctor` to test the installed handlers and `doctor --fix` to repair
outdated launchers. `greatping hook` (singular) is an internal event handler called
by agents, not a command to run manually.

Hooks remain the event mechanism for Claude Code and Codex. Planned native
plugins will package that mechanism with MCP and the skill, with migration to
one active integration owner per agent; they do not replace automatic events
with model-directed tool calls. See **Future integration packages** below.

## MCP tools

`greatping mcp` starts a local stdio server using this computer's credential;
`setup codex` registers it. Prefer these tools when the agent sandbox has no
network access. CLI and MCP share the same operations and validation.

| Tool | Inputs | Result |
|---|---|---|
| `notify` | Optional `message`, `title` | `requestId`, `status: accepted` or `paused` |
| `ask_user` | `question`, optional `choices`, `allowText` (default true), `timeoutSeconds` (10–86400; default 1800) | `requestId`, `status`, `paused`, optional `answer` |
| `get_status` | None | `paired`, `connection`, `alertsPausedUntil`, `deviceCount`, `integrations` |
| `pause_alerts` | `durationSeconds` (60–604800; default 3600) | `alertsPausedUntil` |
| `resume_alerts` | None | `alertsPausedUntil: null` |

Results include both text and structured content with output schemas. Operation
errors return `isError: true` and `{status: "error", code, message}`. Invalid input
is rejected by MCP before the operation runs. The tools declare read-only and
idempotency annotations; those are client hints, not authorization.

CLI and MCP `notify` report `Notification queued.` when alerts are active. The JSON status stays
`accepted`: GreatPing queued the notification, without confirming device delivery.
`paused` means the request is listed in the app without a push. Questions distinguish
`answered`, `expired`, `cancelled` and `resolved`. Cancelling a running question withdraws it
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

A question with choices accepts only one of them unless the user's own words
are allowed. MCP `ask_user` allows them by default, since agents offer choices
as suggestions; pass `allowText: false` when the answer must be a choice.
`greatping ask` is strict for scripts; `--allow-text` opts in. A question
without choices always takes the user's words. On the phone, a yes/no question
gets Yes and No buttons in the notification, plus Reply when own words are
allowed; other choices open the app.

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

A recognized global installation is removed through its owning manager at the
end, after a read-only ownership preflight. npm targets the exact installed
prefix; Vite+ uses `vp uninstall -g greatping`; pnpm, Yarn Classic, Bun and Volta
use their own global removal commands. A missing manager or mismatched ownership
stops before server revocation or local cleanup. The ownership journal survives
a package-removal failure so cleanup can be retried. Checkouts, linked development
packages and unverified installations are preserved with a manual instruction.
No source checkout is deleted. Native Windows manager removal is separate from
the Windows archive qualification, which checks installation and offline commands.

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
`pnpm -F greatping test:package` builds and installs an npm archive outside the
workspace, verifies the executable and bundled skill, and runs the hook, MCP
and PTY suites against that installation. CI builds on Node.js 24 and qualifies
the archive on Node.js 22.20 and Node.js 24. The build uses tsdown; users of the
installed CLI do not need tsdown or the private protocol workspace package.
