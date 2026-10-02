# Security

Please report vulnerabilities privately through GitHub (the **Security** tab of this repository, **Report a vulnerability**) or by email to security@greatping.com. Do not open a public issue for security problems.

The CLI installs hooks into coding agents and holds a machine credential for your GreatPing account, so reports about hook behaviour, credential storage (`~/.config/greatping/config.json`) and anything that could send prompt content off the computer are especially welcome.

## Supported versions

The latest approved npm preview is the security maintenance target. An unreleased
fix on `main` is not proof that an installed package contains it. See the npm
version and matching release notes before upgrading. Older preview versions are
not maintained as separate branches; report their vulnerabilities privately too.

Server/mobile vulnerabilities may affect this client even though those components
are private. Include the affected version, a synthetic reproduction and impact;
never send a real machine credential, account database or private prompt.

Maintainers investigate privately, prepare and verify a fix, and coordinate an
advisory and new release when appropriate. There is no guaranteed response SLA
or bug bounty for this preview. GitHub private reporting is the preferred channel.
