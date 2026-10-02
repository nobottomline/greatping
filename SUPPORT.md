# Support and compatibility

GreatPing is a preview client for the hosted GreatPing product. The mobile app
is in private testing. This repository does not provide a self-hosted server,
store availability, a delivery SLA or native remote approval of agent prompts.

## Runtime and platforms

New source builds require Node.js 22.20 or later. Development and builds use Node
24 LTS from `.node-version`; installed packages declare their own requirements.
CI qualifies the same archive on Node 22.20 and 24 on Linux, macOS and Windows.
Linux/macOS checks include hook fixtures, MCP and interactive PTYs. Windows
checks installation, the npm launcher, help and a removal dry-run. Native Windows
hooks, terminal behavior and credential ACLs are not yet release-qualified.

Synthetic integration tests do not establish compatibility with every future
Claude Code/Codex version or confirm phone delivery. Host updates need explicit
acceptance checks for their lifecycle and settings before support is claimed.

## CLI compatibility

During 0.x, breaking changes require a minor version bump and release notes with
migration instructions; compatible fixes use a patch version. This applies to
minimum Node versions, flags, exit codes, JSON meaning and installed hooks.
Stable releases will follow semantic versioning, with breaking changes in majors.

Scripts should use documented commands, `--json`, exit codes and explicit
terminal states. Human-readable progress and help text are not parsing contracts.
Consumers should tolerate additional JSON fields. An accepted notice is not proof
of phone delivery; acknowledgement, expiry and silence are never authorization.

The latest approved npm preview is maintained. Updating `main` does not update
installed packages. Keep credentials bound to their issuing environment; service
migration and re-pairing must be explicit.

## Getting help

Use an issue for reproducible bugs or feature proposals. Include CLI, Node, OS
and agent versions with a synthetic reproduction. Remove credentials, pairing
codes, personal paths and private messages. Report vulnerabilities through the
private Security channel rather than a public issue. There is no guaranteed
support response time during preview.
