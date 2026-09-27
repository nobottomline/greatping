---
name: greatping
description: Reach the user's phone through GreatPing. Use when the user asks to be pinged, notified or alerted about something (for example "ping me when the deploy finishes"), wants to answer a question from their phone while away, or asks to pause, resume or check GreatPing alerts ("don't ping me for an hour"). Not needed for native questions or permission prompts; GreatPing's hooks already alert for those.
---

# GreatPing

GreatPing sends alerts from this computer to the user's paired phone or tablet. It is a preview: if pairing or the app is unavailable, say so rather than working around it. It is driven by the `greatping` command (or GreatPing's MCP tools, when the host has them).

## What already happens automatically

When GreatPing's hooks are installed, the user's devices are alerted whenever the agent asks a native question or needs a permission, and the alert clears when that prompt closes. Do not send your own alert for those prompts; it would duplicate the automatic one.

## Tools

Prefer GreatPing's MCP tools when the host lists them (`notify`, `ask_user` from the `greatping` server). They run outside the agent sandbox, so they work where shell commands have no network access. Otherwise use the CLI:

| Goal | Command |
|---|---|
| Send an alert | `greatping notify "<message>" --title "<title>"` |
| Ask and wait for an answer | `greatping ask "<question>" --choices Yes,No --timeout 30m` |
| Pause alerts from this computer | `greatping pause 1h` (`30m`, `2h`, up to `7d`) |
| Resume alerts | `greatping resume` |
| Check pairing and integrations | `greatping status` |
| Diagnose or repair | `greatping doctor` (`--fix` to repair hooks) |

`ask` prints only the answer to stdout (`--json` prints `{"requestId","answer"}`); exit code `2` means nobody answered before the timeout. Choices must not contain commas.

## When to use it

- The user asks to be told when something finishes: run the work, then `notify` with the outcome, for example "Deploy finished: 3 services updated" or "Tests failed: 2 failures in api".
- The user says they will be away and wants to decide remotely: use `ask` with short choices and a timeout that fits their absence. Use the answer as their decision.
- The user asks not to be disturbed ("no pings for an hour", "stop alerting me"): run `greatping pause <duration>`. When they want alerts again: `greatping resume`. Pausing silences this computer on all of the user's devices; requests still appear in the app's inbox.
- Otherwise, do not send alerts on your own initiative.

## Rules

- Alerts leave the computer through GreatPing's relay and the push service. Never include secrets, tokens, credentials, private file contents or code in a message. Summarize outcomes in plain words and keep them short (a title of a few words, a body of one or two sentences).
- `ask` does not answer a native prompt. It is a separate question on the phone.
- If a command says the computer is not paired, tell the user to run `greatping login` themselves. Pairing needs their phone, so do not run it for them.
- If alerts are paused, `notify` and `ask` still create the request, but no device is alerted. Tell the user instead of retrying.
