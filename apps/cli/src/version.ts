import { createRequire } from 'node:module';

// package.json ships with the npm package and sits one level above both
// src/ (development) and dist/ (published), so this resolves in either.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION = pkg.version;
