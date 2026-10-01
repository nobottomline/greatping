import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  // The protocol package exports TypeScript source, which Node 20 cannot load at runtime.
  noExternal: ['@greatping/protocol'],
  shims: true,
  clean: true,
  dts: false,
  minify: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // The agent skill ships next to the CLI, so scripted `greatping setup --yes` can install it offline.
  async onSuccess() {
    copyFileSync('../../skills/greatping/SKILL.md', 'dist/SKILL.md');
  },
});
