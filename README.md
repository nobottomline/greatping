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

Hook alerts carry fixed text only: nothing from a prompt (questions, commands, file names) leaves the computer. Messages you send yourself with `notify` or `ask` pass through the GreatPing service and the push provider, so never put secrets in them. The CLI stores its machine credential in `~/.config/greatping/config.json` (or `%APPDATA%\greatping` on Windows), readable only by you.

## The skill

The agent skill is in [`skills/greatping`](skills/greatping/SKILL.md). `greatping setup` offers skill installation as a separate step through the interactive `npx skills` installer. For other agents:

```bash
npx skills add nobottomline/greatping
```

## Removal

`greatping uninstall --dry-run` previews cleanup without changes.
`greatping uninstall` confirms removal of detected integrations, pairing and
local state. Global npm installs are removed through npm when ownership can be
verified; source checkouts are preserved. Changed or unowned files are reported
and preserved. See the [CLI removal reference](apps/cli/README.md#removal).

## This repository

| Path | Contents |
|---|---|
| [`apps/cli`](apps/cli) | The `greatping` command, hooks, MCP server ([command reference](apps/cli/README.md)) |
| [`packages/protocol`](packages/protocol) | Request and response types shared with the service |
| [`skills/greatping`](skills/greatping) | The agent skill |

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
