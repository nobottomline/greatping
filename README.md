# GreatPing

> **Preview.** GreatPing is in active development. The mobile app is in private testing and not yet in the App Store or Google Play, so pairing a computer needs an invitation to the test. Commands, the service address and data may change without notice until the first stable release.

Get an alert on your phone or tablet when a coding agent on your computer needs you: a question, a permission prompt, or a finished turn waiting for your next message.

```bash
npm install -g greatping
greatping login    # pair this computer with the GreatPing app
greatping setup    # Claude Code and Codex alert your devices when they wait
```

## How it works

- **Automatic alerts.** `greatping setup` adds hooks to Claude Code and Codex. Claude Code alerts when it asks a question, needs a permission (not when auto mode decides) or an MCP server asks for input. Codex alerts when it finishes a turn. The alert clears when the prompt closes, you type, or the turn ends.
- **Quiet while you're there.** While you use the computer, an alert waits a short delay (30 seconds by default, set in the app), so a prompt you answer at the keyboard never reaches your phone.
- **On request.** `greatping notify "Deploy finished"` and `greatping ask "Ship it?" --choices Yes,No` work from any script or agent. `greatping mcp` offers the same as MCP tools.
- **In plain words.** The GreatPing skill teaches agents to act on "ping me when the tests pass" or "no pings for an hour" (`greatping pause 1h`).

GreatPing never answers or approves anything on your computer; native prompts stay in the agent.

## Privacy

Hook alerts carry fixed text only: nothing from a prompt (questions, commands, file names) leaves the computer. Messages you send yourself with `notify` or `ask` pass through the GreatPing service and the push provider, so never put secrets in them. The CLI stores its machine credential in `~/.config/greatping/config.json` (or `%APPDATA%\greatping` on Windows), readable only by you.

## The skill

The agent skill is in [`skills/greatping`](skills/greatping/SKILL.md). `greatping setup` installs it for Claude Code and Codex; for other agents:

```bash
npx skills add nobottomline/greatping
```

## This repository

| Path | Contents |
|---|---|
| [`apps/cli`](apps/cli) | The `greatping` command, hooks, MCP server ([command reference](apps/cli/README.md)) |
| [`packages/protocol`](packages/protocol) | Request and response types shared with the service |
| [`skills/greatping`](skills/greatping) | The agent skill |

It is published from GreatPing's internal monorepo; the service and the mobile apps are not open source. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
