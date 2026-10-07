# GreatPing

> **Preview.** GreatPing is in active development. The mobile app is in private testing and not yet in the App Store or Google Play, so pairing a computer needs an invitation to the test. Commands, the service address and data may change without notice until the first stable release.

Get an alert on your phone or tablet when a coding agent on your computer needs you: a question, a permission prompt, or a finished turn waiting for your next message.

The source CLI requires Node.js 22.20 or later. Development uses Node.js 24 LTS;
published versions retain their own declared Node.js requirements.

```bash
npm install -g greatping
greatping login    # pair this computer with the GreatPing app
greatping setup    # Claude Code and Codex alert your devices when they wait
```

## Source and installed releases

This README and the command reference describe `main`, including changes that
may not yet be on npm. `npm install -g greatping` installs the approved npm
release; check `greatping --version` and its `--help` before using a new command.
Use the [release notes](https://github.com/nobottomline/greatping/releases) and
[CHANGELOG.md](CHANGELOG.md) to distinguish released and unreleased behavior.
An automatic source sync does not publish a new npm version.

`greatping update --check` checks npm now and shows how to update the running
installation. Interactive update notices use the detected package manager.
If Vite+ owns your command, use `vp install -g greatping@latest`; Vite+ global
packages and npm global packages are separate installations.

## How it works

- **Automatic alerts.** `greatping setup` adds hooks to Claude Code and Codex. Claude Code alerts when it asks a question, needs a permission (not when auto mode decides) or an MCP server asks for input. Codex alerts when it finishes a turn. The alert clears when the prompt closes, you type, or the turn ends.
- **Quiet while you're there.** While you use the computer, an alert waits a short delay (30 seconds by default, set in the app), so a prompt you answer at the keyboard never reaches your phone.
- **On request.** `greatping notify "Deploy finished"` and `greatping ask "Ship it?" --choices Yes,No` work from any script or agent. `greatping mcp` exposes `notify`, `ask_user`, `get_status`, `pause_alerts` and `resume_alerts`.
- **In plain words.** The GreatPing skill teaches agents to act on "ping me when the tests pass" or "no pings for an hour" (`greatping pause 1h`).

GreatPing never answers or approves anything on your computer; native prompts stay in the agent.

The CLI connects to the GreatPing service automatically; there is no server
configuration. The preview continues to use the current testing service. An
existing credential is never moved silently to a different backend.

## Privacy

Hook alerts carry fixed text only: nothing from a prompt (questions, commands, file names) leaves the computer. Content sent with `notify` or `ask` is encrypted to verified account devices before reaching the service. Providers still see routing metadata; the device decrypts alert content. The CLI stores its machine credential in `~/.config/greatping/config.json` (or `%APPDATA%\greatping` on Windows), readable only by you.

## The skill

The agent skill is in [`skills/greatping`](skills/greatping/SKILL.md). `greatping setup` offers skill installation as a separate step through the interactive `npx skills` installer. For other agents:

```bash
npx skills add nobottomline/greatping
```

## Agent plugins

CLI 0.4.0 provides [native OpenCode and Pi adapters](plugins/native-adapters.md).
Run `greatping setup opencode --yes` or `greatping setup pi --yes`, then restart
the host. Both packages are bundled locally; no second download is needed.
CLI 0.3.3 and earlier lack this support. OpenCode covers questions, permissions and
finished responses; Pi covers extension UI prompts and settled responses, with
five native GreatPing tools. The guide records tested host versions and limits.

The preview [Claude Code and Codex plugins](plugins/README.md) package hooks, local
MCP and the same skill. They require an installed GreatPing CLI >=0.4.0 and
Node.js >=22.20.0. CLI 0.4.0 configures an installed plugin with `greatping setup claude|codex`
and migrates direct integrations with `--migrate`. Codex still requires hook trust
in `/hooks`; automatic questions and permissions are covered only in Claude Code.

The source contains Git marketplace catalogs. See the plugin guide for local
installation, source-versus-release prerequisites and migration. Official plugin
directory acceptance and phone-delivery qualification are separate steps.
Keep `npx skills` for hosts where you use the skill independently.

## Removal

`greatping uninstall --dry-run` previews cleanup without changes.
`greatping uninstall` confirms removal of detected integrations, pairing and
local state. Recognized global installs are removed through their original
manager after ownership verification; source checkouts are preserved. Changed or unowned files are reported
and preserved. See the [CLI removal reference](apps/cli/README.md#removal).

## This repository

| Path | Contents |
|---|---|
| [`apps/cli`](apps/cli) | The `greatping` command, hooks, MCP server ([command reference](apps/cli/README.md)) |
| [`packages/protocol`](packages/protocol) | Request and response types shared with the service |
| [`skills/greatping`](skills/greatping) | The agent skill |
| [`plugins`](plugins) | Claude Code/Codex plugins, OpenCode/Pi adapters and installation guides |

It is published from GreatPing's internal monorepo; the service and the mobile apps are not open source. See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md),
[SECURITY.md](SECURITY.md) and [community conduct](CODE_OF_CONDUCT.md).

## Contact

For help with GreatPing or private support questions, email
[support@greatping.com](mailto:support@greatping.com). Reproducible CLI bugs and
feature proposals can also be posted as [GitHub issues](https://github.com/nobottomline/greatping/issues).
See [SUPPORT.md](SUPPORT.md) for compatibility and reporting guidance.

Report security vulnerabilities privately to
[security@greatping.com](mailto:security@greatping.com) or through
[GitHub private reporting](https://github.com/nobottomline/greatping/security/advisories/new).
See [SECURITY.md](SECURITY.md); do not disclose vulnerabilities in public issues.

## License

[MIT](LICENSE)


Cursor IDE local preview: `greatping setup cursor --yes` installs the bundled
native plugin with completion hooks, MCP tools and skill. Reload the IDE and
inspect Customize. Native question/permission waiting and Agent CLI plugin
loading are not qualified. See [Cursor guide](plugins/cursor.md) and
[alert troubleshooting](plugins/troubleshooting.md). This installer requires a
CLI >=0.4.0.
