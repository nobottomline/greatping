import { defineConfig } from 'tsdown';

// The simulated phone must run on archive-test runners without workspace deps.
// Keep it beside the qualification artifact, outside the published CLI package.
export default defineConfig({
  entry: ['fixtures/pairing-fetch.mjs'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  deps: { alwaysBundle: [/^@greatping\/protocol(?:\/|$)/, /^@noble\//, 'zod'] },
  outExtensions: () => ({ js: '.mjs' }),
  clean: true,
  dts: false,
});
