# Support and compatibility

GreatPing is a preview client for the hosted GreatPing product. The mobile app
is in private testing. This repository does not provide a self-hosted server,
store availability, a delivery SLA or native remote approval of agent prompts.

## Runtime and platforms

New source builds require Node.js 22.20 or later. Development and builds use Node
24 LTS from `.node-version`; installed packages declare their own requirements.
CI is configured to qualify the same archive on Node 22.20 and 24 on Linux,
macOS, Windows and Ubuntu 24.04 under WSL1/WSL2. Linux/macOS/WSL checks include
hook fixtures, MCP and interactive PTYs. Windows checks both PowerShell 5.1 and
7, npm CMD launchers, literal arguments, pairing, encrypted notify/ask fixtures,
installed hook execution, credential ACLs and owned process-tree cancellation.
These jobs must pass for the candidate being released; configuration alone is
not evidence of a successful native run. Real agent trust/activation, Windows
console Ctrl+C and phone delivery still need real-host acceptance.

Install Node and GreatPing inside the same environment as the agent. For WSL,
use Linux Node and keep configuration in the distribution's Linux filesystem,
not a shared `/mnt/c` directory. Windows uses built-in Windows PowerShell to
secure private state and execute encoded hook launchers. Permission failures
stop credential access; do not bypass them by disabling Windows protections.

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

Email [support@greatping.com](mailto:support@greatping.com) for help with
GreatPing or questions that should stay private. Use a
[GitHub issue](https://github.com/nobottomline/greatping/issues) for reproducible
CLI bugs or feature proposals.

Include CLI, Node, OS and agent versions with a synthetic reproduction. Remove
credentials, pairing codes, personal paths and private messages from reports,
including email. Report vulnerabilities to
[security@greatping.com](mailto:security@greatping.com) or through
[GitHub private reporting](https://github.com/nobottomline/greatping/security/advisories/new),
as described in [SECURITY.md](SECURITY.md). Do not disclose them in public issues.
There is no guaranteed support response time during preview.
