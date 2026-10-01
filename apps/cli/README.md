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
greatping mcp                # ask_user and notify over MCP stdio
greatping logout
```

From a checkout, build with `pnpm -F greatping build` and run `node apps/cli/dist/index.js <command>`.

Every command has `--help`. `login` names the computer as the OS does (for example "Alex's MacBook Pro"; override with `--name`), prints a QR code and a manual code, and waits with a countdown. When Claude Code or Codex is installed but not alerting yet, an interactive `login` offers `setup`; non-interactive runs only print the hint and never change another tool's settings. The CLI saves its bearer credential under `~/.config/greatping/config.json` on macOS/Linux or `%APPDATA%\greatping\config.json` on Windows with user-only permissions.

## Output contract

- stdout carries only results: the `ask` answer, `--json` objects, `--version`. Messages, spinners and prompts go to stderr, so `answer=$(greatping ask …)` works.
- Color is used sparingly and follows `NO_COLOR`, `FORCE_COLOR` and `--no-color`; it is off when stderr is not a terminal. Spinners and prompts appear only when stdin and stderr are terminals and `CI` is unset.
- The terminal QR code is drawn with background colors, dark on white, so it scans on light and dark themes; without color it falls back to half blocks.
- Exit codes: `0` success, `1` error (including "not paired" for `status`), `2` the question or pairing code ended without an answer, `130`/`143` interrupted. On those signals `ask` withdraws the question from the phone.
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
confirmation to `npx skills add nobottomline/greatping --skill greatping --global`.
Skipping leaves existing skills installed; `--no-skill` skips this step entirely.
The step also appears when alert settings are already up to date. npm's runner
fetch is accepted automatically; the skills installer keeps its own prompts.
It uses the npm/Node runtime on PATH (the current skills runner requires Node.js
22.20 or later). Its output goes to stderr, keeping GreatPing's stdout contract.
A failed skill installation leaves saved alert settings intact and provides a
retry command. `setup --yes` retains the existing bundled, offline skill install
for scripts and does not run npx.

Agent behavior:

- **Claude Code**: hooks alert when it asks a question, needs a permission (not when auto mode decides) or an MCP server asks for input, and resolve the alert when the prompt closes, the user types, or the turn ends. `--finished` also alerts when an interactive session finishes a turn.
- **Codex**: hooks alert when it finishes a turn and waits for you, and resolve when you reply. Codex runs new hooks only after you trust them in `/hooks`. `setup` also registers the MCP tools through `codex mcp add`, because the Codex sandbox usually blocks network access for shell commands.
- **Both**: the GreatPing skill (`skills/greatping/SKILL.md`, also installable with `npx skills add nobottomline/greatping`), so "ping me when the deploy is done" or "no pings for an hour" work in plain words.

Alerts are generic: nothing from a prompt leaves the computer, and GreatPing never answers a prompt. Hooks run in the background, fail silently and never delay the agent. An alert waits for the computer's presence delay (30 s by default, set in the app) unless nobody has used the computer for two minutes, so a prompt answered at the keyboard never reaches your devices. `GREATPING_DISABLE=1` silences hooks for one shell or session. `setup --remove` undoes everything; `hooks install|uninstall [claude|codex]` manages only the hooks.

`greatping doctor` runs each installed hook with a test event and reports broken, outdated (from an older CLI or tied to one Node version) or never-run hooks; `--fix` repairs them.

`greatping mcp` starts a local stdio MCP server with `ask_user` and `notify` tools, using the same paired machine credential; `setup codex` registers it.

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
