# @greatping/protocol

Request and response types, Zod schemas, limits and code helpers shared by the GreatPing CLI, service and apps. It is the wire contract between them, so the CLI validates what it sends with the same schemas the service applies.

The package is not published on its own: it exports TypeScript source and is bundled into the `greatping` CLI at build time.

```ts
import { createRequestBodySchema, LIMITS, type PingRequest } from '@greatping/protocol';
```

```bash
pnpm -F @greatping/protocol typecheck
```
