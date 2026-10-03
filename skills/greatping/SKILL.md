---
name: greatping
description: Reach the user's phone through GreatPing. Use when the user asks to be pinged, notified or alerted about something (for example "ping me when the deploy finishes"), wants to answer a question from their phone while away, or asks to pause, resume or check GreatPing alerts ("don't ping me for an hour"). Not needed for native questions or permission prompts; GreatPing's hooks already alert for those.
---

# GreatPing

GreatPing sends alerts from this computer to the user's paired phone or tablet. It is a preview: if pairing or the app is unavailable, say so rather than working around it. It is driven by the `greatping` command (or GreatPing's MCP tools, when the host has them).

## What already happens automatically

When GreatPing's hooks are installed, the user's devices are alerted whenever the agent asks a native question or needs a permission, and the alert clears when that prompt closes. Do not send your own alert for those prompts; it would duplicate the automatic one.

## Tools

Prefer GreatPing's MCP tools when the host lists them (`notify`, `ask_user`, `get_status`, `pause_alerts`, `resume_alerts` from the `greatping` server). They run outside the agent sandbox, so they work where shell commands have no network access. Otherwise use the CLI:

| Goal | MCP tool | CLI fallback |
|---|---|---|
| Send an alert | `notify` | `greatping notify "<message>" --title "<title>"` |
| Alert when one long command ends | — | `greatping run -- <command>` (`--on-fail` for failures only) |
| Ask and wait for an answer | `ask_user` | `greatping ask "<question>" --choices Yes,No --timeout 30m` |
| Pause alerts from this computer | `pause_alerts` | `greatping pause 1h` (`30m`, `2h`, up to `7d`) |
| Resume alerts | `resume_alerts` | `greatping resume` |
| Check pairing and integrations | `get_status` | `greatping status` |
| Diagnose or repair | — | `greatping doctor` (`--fix` to repair hooks) |

`ask` prints the answer to stdout; `--json` returns `requestId`, `status`, `paused` and an optional `answer`. Exit code `2` means the question ended without an answer. CLI choices use comma-separated text; MCP choices are an array. A notification marked `accepted` was accepted by the service; phone delivery is not confirmed.

## When to use it

- The user asks to be told when something finishes: run the work, then `notify` with the outcome, for example "Deploy finished: 3 services updated" or "Tests failed: 2 failures in api". When the work is one long shell command, `greatping run -- <command>` does this by itself (success or exit code and duration, exiting with the command's code); `notify` afterwards only if the user needs more than that.
- The user says they will be away and wants to decide remotely: use `ask` with short choices and a timeout that fits their absence. Use the answer as their decision.
- The user asks not to be disturbed ("no pings for an hour", "stop alerting me"): run `greatping pause <duration>`. When they want alerts again: `greatping resume`. Pausing silences this computer on all of the user's devices; requests still appear in the app's inbox.
- Otherwise, do not send alerts on your own initiative.

## Rules

- Alerts leave the computer through GreatPing's relay and the push service. Never include secrets, tokens, credentials, private file contents or code in a message. Summarize outcomes in plain words and keep them short (a title of a few words, a body of one or two sentences).
- `ask` does not answer a native prompt. It is a separate question on the phone.
- If a command says the computer is not paired, tell the user to run `greatping login` themselves. Pairing needs their phone, so do not run it for them.
- If alerts are paused, `notify` and `ask` still create the request, but no device is alerted. Tell the user instead of retrying.

- Use pause and resume only at the user’s request. Installation, pairing, repair and removal are CLI administration; they are not MCP tools.
