# Cursor IDE integration

## Decision and coverage

Use the Cursor-native plugin format, `.cursor-plugin/plugin.json`, for hooks,
MCP and the canonical GreatPing skill. The root Agent Plugins format currently
loads only skills and MCP in Cursor, so it cannot supply completion hooks.
No VS Code extension, new transport, pairing store or runtime download is needed.

Sources checked on 2026-10-07:

- [Cursor plugin reference](https://cursor.com/docs/reference/plugins)
- [Local plugin loading and policy](https://cursor.com/docs/plugins#test-plugins-locally)
- [Hooks, payloads and execution contract](https://cursor.com/docs/hooks)
- Installed Cursor IDE **3.20.17**, commit `0c32194e3fb5ffaced9fb36430b860ec301e1fc0`.

The plugin observes only `sessionStart`, `beforeSubmitPrompt`, `stop` and
`sessionEnd`. Only `stop.status === "completed"` can open a completion alert;
errors, cancellation and session cleanup close previous alerts. It does not
subscribe to subagent events, tool execution, transcripts or agent thoughts.
The conversation ID becomes an opaque keyed thread ID in the CLI. Prompt text,
email, transcript paths and model output never enter the attention payload.
Hook responses allow continuation and never inject a follow-up message.

Cursor does not document a reliable question-open or approval-wait hook.
`beforeShellExecution` and `preToolUse` are execution-policy hooks, not evidence
that a user has been asked. Do not invent permission alerts from them. Explicit
MCP `notify` and separately requested `ask_user` remain available.

## Local preview

Requires a GreatPing CLI build containing Cursor adapter support, and Node.js
>=22.20.0 available as `node` to the IDE. Released CLI 0.3.3 lacks this installer.

```sh
pnpm plugins:build
pnpm -F greatping build
node apps/cli/dist/index.js setup cursor --yes
node apps/cli/dist/index.js doctor --verbose
```

The installer copies the package to `~/.cursor/plugins/local/greatping`. An
external symlink is deliberately avoided: Cursor skips local-plugin links that
resolve outside its local-plugin directory. Reload the IDE, then inspect
Customize for the skill, MCP server and plugin components. Local imports must
be allowed by organization policy; a same-name marketplace plugin takes
precedence. CLI inspection verifies owned files and configuration, not that
Cursor enabled them. Agent CLI loading is not qualified by this preview.

The installer preserves user `hooks.json`, `mcp.json`, foreign plugins and
pairing. A separate `greatping` MCP registration is a conflict: remove it through
its installer before enabling plugin MCP. Modified or unowned local plugin
files are preserved and cannot be overwritten or deleted by setup. Use
`setup cursor --remove --yes` to remove the owned local copy. Pairing remains.
The stable CLI launcher and completion preference live outside the plugin cache.
Completion defaults on; `--no-finished` disables it.

## Qualification and release

CLI regression tests exercise completed/error/aborted payloads, cleanup, opaque
identifiers, private-field exclusion, repeatable installation, foreign settings,
ownership refusal and removal. Plugin tests check the generated manifest, MCP
root placeholder and fail-open JSON responses. The installed 3.20.17 component
parser was loaded in isolation from `cursor-agent-exec/dist/main.js`, with a
read-only filesystem fetcher and instrumentation exposing its discovery class.
It discovered the GreatPing skill, all four hooks and MCP server. No extension
activation, authenticated IDE agent turn or phone delivery is claimed by this
parser check. Native Windows/Linux execution remains a separate acceptance gate.

Generated hooks and MCP use `${CURSOR_PLUGIN_ROOT}`, which Cursor expands.
`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are not supported by Cursor's MCP loader.
Hooks have a 10-second host timeout; the bridge bounds its CLI child to 8 seconds.
These are notification observers; failure must never approve or deny an action.

The public OSS export includes `.cursor-plugin/marketplace.json` pointing to
`plugins/cursor/greatping`. After public source/release qualification, submit
that public Git repository at [Cursor Marketplace](https://cursor.com/marketplace/publish).
Cursor reviews plugins before listing them. Source publication, npm release,
submission and approval have not happened in this task.
