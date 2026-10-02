# Contributing

This repository is published from GreatPing's internal monorepo, which also holds the service and the mobile apps. Every change here is synchronised from there, so pull requests are not merged directly: we apply accepted changes upstream and they appear here with the next sync, credited to you.

Issues and pull requests are welcome. Before a larger change, open an issue to discuss it.

Use Node.js 24 LTS (24.11 or later within 24.x), as recorded in `.node-version`.
The installed CLI supports Node.js 22.20 and later; CI tests the packed CLI on
22.20 and 24 on Linux and macOS with hooks, MCP and PTY fixtures. Windows CI
checks package installation, the npm launcher and offline commands. Native
Windows agent hooks and credential ACLs require separate qualification.

```bash
pnpm install --frozen-lockfile
pnpm secrets:install
pnpm secrets
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm -F greatping test:package
node apps/cli/dist/index.js --help
```

Biome owns formatting, import organization and general linting. Oxlint adds
`no-floating-promises`, `no-misused-promises` and `await-thenable` with type
information, without duplicating Biome's general rules. These checks cover
production code; test harnesses are excluded because they deliberately hand
async callbacks to their test runner. TypeScript remains the type checker.
Knip checks unused files, exports and dependencies after both lint passes.
System commands `scutil` and `hostnamectl` are intentional platform integrations,
not missing npm dependencies. Gitleaks 8.30.1 is installed into ignored `.tools/`
from upstream release archives with pinned SHA-256 checks. `pnpm secrets` checks
complete Git history and current tracked/non-ignored candidate files; it prints
only rule IDs and locations, never matching values or source snippets. Scanner
errors and shallow history fail the gate. Secret scanning runs on pull requests,
pushes, weekly and before release qualification. No npm installation is needed
for that workflow. On Windows, install the same Gitleaks version independently
and set `GITLEAKS_BIN`; the bootstrap supports macOS and Linux.
The CLI uses tsdown over Rolldown, with an explicit ESM output path, source maps
and an offline bundled skill. `test:package` installs the npm archive in a
temporary directory and checks its resources, hooks, MCP and interactive setup.

## Dependency updates and ownership

Dependabot opens weekly grouped dependency and Actions updates. Security alerts
and security update PRs are enabled separately in repository settings. Accepted
updates are applied in the internal repository, with its lockfile, then exported;
public PRs must not be merged directly and lost on the next sync. Updates are not
automatically merged. CODEOWNERS identifies the maintainer for release tooling,
configuration and integrations.

## Releases

Versions are deliberately bumped in the internal monorepo. Source changes alone
create a public sync commit, never a new npm version. Changes that raise the
minimum Node version or break flags, output or integration behavior require a
minor version bump during 0.x and a migration note in CHANGELOG.md.

For a new version, the release workflow runs the same source and installed-package
checks as CI. One archive is qualified on every supported runtime, then saved as
GitHub release assets: `greatping.tgz`, `greatping-<version>.tgz`, `release.json`
and `SHA256SUMS`. The metadata records the source commit, SHA-256 and npm-style
SHA-512 integrity. A retry downloads and verifies those assets from the original
tag; it never replaces them or publishes a newly built archive under that version.
An incomplete tag/release or registry outage blocks the workflow for inspection.

When `NPM_PUBLISH=true`, npm 11.21.0 submits the checked archive through OIDC with
provenance to npm staging. A maintainer reviews its integrity and approves it
with npm 2FA. A staging conflict stays an error until inspected; do not approve
an unknown artifact or silently treat arbitrary errors as an existing stage.
Once approved, check the registry integrity, dist-tag and provenance. Source
sync, GitHub assets, npm staging, npm approval, service deployment and mobile
releases are separate states. Workflow summaries say which state was reached;
a successful no-op is not a publication.

Do not change or delete published versions. Fix a bad release in a new version;
use npm deprecation for a confirmed defective release when appropriate. If an
unpublished archive must change, use a new version rather than editing assets.

GitHub native release immutability is enabled for future releases. The workflow
creates a draft, attaches all assets and then publishes it, locking both assets
and tag. Existing historical releases are not retroactively changed. An incomplete
draft or an unpublished mutable release requires explicit recovery before retry.
