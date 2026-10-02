import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // The private workspace package exports TypeScript; the npm CLI must be self-contained.
  deps: {
    alwaysBundle: ['@greatping/protocol'],
  },
  shims: true,
  clean: true,
  dts: false,
  minify: false,
  sourcemap: true,
  outExtensions: () => ({ js: '.js' }),
  banner: { js: '#!/usr/bin/env node' },
  // Scripted setup installs the bundled skill offline.
  copy: [{ from: '../../skills/greatping/SKILL.md', to: 'dist' }],
});
