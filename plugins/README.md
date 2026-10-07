# GreatPing agent plugins

Native **OpenCode and Pi** adapters and a **Cursor IDE** plugin are implemented.
See the [Cursor guide](cursor.md) and [alert troubleshooting](troubleshooting.md). Their installation,
coverage, source-build prerequisites and verification are documented in the
[native adapter guide](native-adapters.md). The remainder of this guide describes
the Claude Code and Codex plugin packages.

Claude Code and Codex preview packages combine automatic hooks, the five local
MCP tools and the GreatPing skill. They launch an installed GreatPing CLI; pairing,
credentials, transport and event handling remain in that CLI. There is one
canonical skill and one launcher source. No hook downloads or installs a package.

| Host | Automatic coverage | Completion default |
| --- | --- | --- |
| Claude Code | Native questions, permission requests, MCP input dialogs and their cleanup | Off; explicitly enable with `--finished` |
| Codex | Finished turns and cleanup on new input or session boundaries | On; disable with `--no-finished` |

Native answers and approvals stay in the host. MCP `ask_user` creates a separate
GreatPing question only when requested. Installing a plugin does not grant hook
trust; review it in the host, including Codex `/hooks`.

## Prerequisites

- GreatPing CLI **>=0.4.0 and <1.0.0**, installed separately and paired through
  `greatping login`. Check `greatping --version`; source sync does not release npm.
- Node.js **>=22.20.0**, available as `node` in the host's environment. A saved
  CLI launcher does not remove this bootstrap requirement.
- A stable executable path that survives runtime updates. The configurator
  rejects version-specific Node paths and `fnm_multishells` launchers. Windows
  `.cmd` launchers require explicit `node.exe` and the CLI JavaScript entrypoint.

These are local plugins. They do not run as remote ChatGPT plugins. Native
installation was verified with Claude Code 2.1.288 and Codex CLI 0.160.0 on macOS;
other host versions and native Windows execution need separate qualification.

## Installation

For local development, generate a complete marketplace **outside this checkout**:

```sh
node scripts/build-agent-plugins.mjs --output /tmp/greatping-marketplace
claude plugin marketplace add /tmp/greatping-marketplace
claude plugin install greatping@greatping
codex plugin marketplace add /tmp/greatping-marketplace --json
codex plugin add greatping@greatping --json
```

The internal checkout stores public root catalogs under `oss/`; it is not a
marketplace root. The OSS exporter overlays them into the public repository.
After this change is synced there, Git marketplace installation becomes:

```sh
claude plugin marketplace add nobottomline/greatping
claude plugin install greatping@greatping
codex plugin marketplace add https://github.com/nobottomline/greatping.git --json
codex plugin add greatping@greatping --json
```

With the plugin-aware CLI, configure the installed package without looking up
cache paths:

```sh
greatping setup claude
greatping setup codex
greatping doctor
greatping status --json
```

`setup` finds a user-level native plugin registration, saves a stable launcher,
and uses the plugin's existing hooks, MCP and skill. It does not install duplicate
components or run `npx skills` for that host. `--finished` and `--no-finished`
change the plugin's completion preference. Use `--yes` for noninteractive setup.
Disabled plugins stay disabled; enable them through their host manager first.
Restart the host or reconnect MCP; Codex still needs hook trust in `/hooks`.

**Source versus release:** plugin-aware setup is implemented in this source
checkout and is included in CLI 0.4.0. Test it with
`pnpm -F greatping build` followed by
`node apps/cli/dist/index.js setup claude --yes` (or `codex`). CLI 0.3.3 and earlier must be updated before using these packages.

For an explicit launcher, use `claude plugin list --json`
(`installPath`) or `codex plugin add` output / its native inventory and cache to
locate the installed package, then run:

```sh
node "/path/to/installed/greatping/scripts/bridge.mjs" claude configure
node "/path/to/installed/greatping/scripts/bridge.mjs" claude check
# Use codex instead of claude for the Codex package.
```

To select an explicit stable launcher, use an absolute executable and repeated
prefix arguments. For example, when those are the actual installed paths:

```sh
node /path/to/installed/greatping/scripts/bridge.mjs claude configure \
  --command /usr/local/bin/node --arg /usr/local/bin/greatping --finished
```

`configure` saves only launcher and alert preferences, outside the plugin cache:
`$XDG_CONFIG_HOME/greatping/plugins/{claude,codex}.json`, otherwise
`~/.config/greatping/plugins/` on macOS/Linux or `%APPDATA%\greatping\plugins\` on
Windows. Files are private on POSIX. Reconfiguring retains existing preferences;
plugin updates retain the configuration. Rerun it if the CLI installation moves.
It does not change pairing, host settings or trust decisions.

## Migrating from CLI setup or an independent skill

Keep one owner for each host integration. Configure the plugin **before** removing
CLI hooks: it captures the existing Claude completion and alert-category choices.
While recognized user-level CLI hooks exist, plugin hooks stand by. Plugin MCP
refuses to start alongside a separately registered user-level `greatping` server.

With a plugin-aware CLI, preview and apply migration through one command:

```sh
greatping setup claude --migrate
# or: greatping setup codex --migrate
```

It configures the plugin first, retaining existing completion and Claude alert
category preferences, then removes direct integrations through their owning
installers. Pairing, foreign settings and native plugin registration remain.
Changed or unowned assets are preserved and reported; failed migration can be
retried. `--yes` approves the shown migration noninteractively.

For an explicit launcher, configure the bridge first, then use
`greatping setup claude --remove` or `greatping setup codex --remove` and remove
separate MCP/skills through their original manager. Do not delete shared skill
links by hand. `npx skills` remains supported for other hosts.

`status --json` and MCP `get_status` include local `plugins` diagnostics:
absent, disabled, unconfigured, ready, broken or unknown, plus conflicts and
`hookTrust: host-managed`. `ready` means the registered package and launcher
configuration are present; `doctor` additionally runs the launcher compatibility
check using `node` on PATH. Neither proves host activation or phone delivery.
Device reports use existing hooks/MCP/skill fields and omit package paths.

Detection is qualified against Claude Code's version-2 user installation
inventory and Codex CLI 0.160.0 registrations/cache. Unknown schemas, project or
managed scope and ambiguous entries are reported instead of guessed. Explicit
CLI diagnostics can ask `codex plugin list --json` to select among cache versions;
background hook reports never spawn a host manager and report ambiguity
conservatively. Inspect project/enterprise settings and the host UI separately.

`doctor --fix` repairs plugin preferences/launchers without installing direct
hooks or MCP. It does not migrate conflicts or enable a disabled plugin; use
`setup --migrate` and the native manager. `hooks install` refuses a registered
plugin, while `hooks uninstall` and `setup --remove` affect direct CLI assets.
Valid preferences survive repairs. Explicit reconfiguration of malformed plugin
preferences resets invalid values to defaults; pairing stays separate.

## Removal and troubleshooting

```sh
claude plugin uninstall greatping@greatping
codex plugin remove greatping@greatping
```

Restart existing sessions after removal. Pairing and CLI remain; the private
plugin preferences are retained for reinstall. Full CLI uninstall is a separate
operation: remove the plugins first. Their native registration is owned by the
host manager and is not removed by the CLI uninstaller.

Hook errors are silent and return success, with an eight-second process deadline;
MCP diagnostics go only to stderr and preserve protocol stdout. Use `check` for
missing launchers, incompatible CLI versions and integration conflicts.
`GREATPING_DISABLE=1` silences automatic plugin hooks for that environment.

## Sources, verification and distribution

Edit `plugins/shared/bridge.mjs` and `skills/greatping/SKILL.md`, then run
`pnpm plugins:build`. Host packages and catalogs are committed generated output.
`pnpm plugins:check` detects drift in both the internal and public repository.
`pnpm plugins:test` checks configuration, copied caches, symlink paths, limited
PATH, migration safeguards, MCP forwarding, fail-open hooks and process cleanup.
`pnpm plugins:test:hosts` requires installed Claude/Codex and a built CLI; it
installs and removes both plugins in disposable homes without real credentials.

Native verification exercises install/list/remove, copied skills, hook entrypoints,
MCP initialization, all five tool definitions and read-only unpaired status. It
does not exercise native prompt dispatch, trust, remote API or phone delivery.
The existing CLI lifecycle tests cover event handling separately. A release
qualification must still run actual host prompts through delivery and resolution.

Git marketplaces are our first distribution channel. Official directory listing
and review are separate from installation; these source packages are not a claim
of acceptance. Prepare verified public sources, metadata and privacy/support
material before submitting under the current platform rules. See
[OpenAI packaging](https://developers.openai.com/plugins/build/plugins),
[Claude manifests](https://code.claude.com/docs/en/plugins-reference) and
[Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

Keep the independently installable `npx skills` channel for other hosts.
OpenCode/Pi now use thin native adapters that reuse the installed CLI.
`pnpm plugins:test:native` qualifies their actual lifecycle dispatch with local
fixtures. Extract client code only after E2E contracts stabilize and a measured
need justifies it.
