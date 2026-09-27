# GreatPing CLI

Get an alert on your phone or tablet when a coding agent on this computer needs you. Requires Node.js 20 or later and the GreatPing app.

```bash
npm install -g greatping     # or: npm install -g https://github.com/nobottomline/greatping/releases/latest/download/greatping.tgz
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

`greatping setup` asks once, then configures every detected agent (`--yes` when not interactive, `setup claude` or `setup codex` for one):

- **Claude Code**: hooks alert when it asks a question, needs a permission (not when auto mode decides) or an MCP server asks for input, and resolve the alert when the prompt closes, the user types, or the turn ends. `--finished` also alerts when an interactive session finishes a turn.
- **Codex**: hooks alert when it finishes a turn and waits for you, and resolve when you reply. Codex runs new hooks only after you trust them in `/hooks`. `setup` also registers the MCP tools through `codex mcp add`, because the Codex sandbox usually blocks network access for shell commands.
- **Both**: the GreatPing skill (`skills/greatping/SKILL.md`, also installable with `npx skills add nobottomline/greatping`), so "ping me when the deploy is done" or "no pings for an hour" work in plain words.

Alerts are generic: nothing from a prompt leaves the computer, and GreatPing never answers a prompt. Hooks run in the background, fail silently and never delay the agent. An alert waits for the computer's presence delay (30 s by default, set in the app) unless nobody has used the computer for two minutes, so a prompt answered at the keyboard never reaches your devices. `GREATPING_DISABLE=1` silences hooks for one shell or session. `setup --remove` undoes everything; `hooks install|uninstall [claude|codex]` manages only the hooks.

`greatping doctor` runs each installed hook with a test event and reports broken, outdated (from an older CLI or tied to one Node version) or never-run hooks; `--fix` repairs them.

`greatping mcp` starts a local stdio MCP server with `ask_user` and `notify` tools, using the same paired machine credential; `setup codex` registers it.

The default API is `https://greatping-api-dev.ueldo343.workers.dev`. Override it with `--server <url>` or `GREATPING_API_URL`; the phone app must target the same environment before pairing. Set `GREATPING_DEBUG=1` to print stack traces for unexpected errors.
