# Contributing

This repository is published from GreatPing's internal monorepo, which also holds the service and the mobile apps. Every change here is synchronised from there, so pull requests are not merged directly: we apply accepted changes upstream and they appear here with the next sync, credited to you.

Issues and pull requests are welcome. Before a larger change, open an issue to discuss it.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm -F greatping test:interactive
node apps/cli/dist/index.js --help
```

## Releases

A release is cut automatically when `apps/cli/package.json` gets a new version: the release workflow runs the checks, tags `v<version>`, and attaches the npm package to a GitHub release (`greatping.tgz` always points at the latest one).

Updating the public source without changing the CLI version does not replace an
existing npm package. npm publication is staged by trusted publishing and requires
maintainer approval. Service and mobile deployments are separate delivery steps.
