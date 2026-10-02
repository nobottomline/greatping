import { createRequire } from 'node:module';

// package.json ships with the npm package and sits one level above both
// src/ (development) and dist/ (published), so this resolves in either.
const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
  engines: { node: string };
};

export const VERSION = pkg.version;
export const MIN_NODE_VERSION = pkg.engines.node.replace(/^>=/, '');

/** Keep hook launchers and the CLI's startup check aligned with the npm contract. */
export function supportsNodeVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number);
  const minimum = MIN_NODE_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
