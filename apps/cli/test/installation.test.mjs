import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { detectInstallation, verifyRemoval } from '../src/installation.ts';
import { currentLauncher } from '../src/integrations/launcher.ts';

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function entry(root) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  const script = join(root, 'dist/index.js');
  writeFileSync(script, '// fixture');
  chmodSync(script, 0o755);
  json(join(root, 'package.json'), {
    name: 'greatping',
    version: '1.0.0',
    bin: { greatping: './dist/index.js' },
  });
  return script;
}
function tool(bin, name, code = '') {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${code}`);
  chmodSync(path, 0o755);
  return path;
}
async function sandbox(run) {
  const home = mkdtempSync(join(tmpdir(), 'greatping-installation-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  try {
    await run({ home, bin, env: { HOME: home, PATH: bin } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('global manager evidence produces the correct update and removal commands', () =>
  sandbox(({ home, bin, env }) => {
    const cases = [
      [
        'npm',
        join(home, 'node versions/v24.21.0/lib/node_modules/greatping'),
        'npm',
        'npm install --global --prefix',
      ],
      [
        'pnpm',
        join(home, 'pnpm/global/5/node_modules/.pnpm/greatping@1.0.0/node_modules/greatping'),
        'pnpm',
        'pnpm add --global',
      ],
      ['yarn', join(home, '.config/yarn/global/node_modules/greatping'), 'yarn', 'yarn global add'],
      ['bun', join(home, '.bun/install/global/node_modules/greatping'), 'bun', 'bun add --global'],
      [
        'volta',
        join(home, '.volta/tools/image/packages/greatping/lib/node_modules/greatping'),
        'volta',
        'volta install',
      ],
    ];
    for (const [manager, root, executable, update] of cases) {
      const script = entry(root);
      tool(bin, executable);
      const installation = detectInstallation(script, env);
      assert.equal(installation.manager, manager);
      assert.ok(installation.updateCommand.startsWith(update));
      assert.equal(installation.removal.executable, join(bin, executable));
      assert.ok(installation.removal.args.includes('greatping'));
    }
  }));

test('Vite+ metadata and shared shim identify the selected installation and stable hook launcher', () =>
  sandbox(({ home, bin, env }) => {
    const store = join(home, 'custom-vp-data/packages/greatping');
    const id = '2715ef2b-1831-40e2-9d40-69121bf6c137';
    const script = entry(join(store, id, 'lib/node_modules/greatping'));
    const metadata = { name: 'greatping', version: '1.0.0', installId: id, bins: ['greatping'] };
    json(`${store}.json`, metadata);
    const vp = tool(bin, 'vp');
    symlinkSync(vp, join(bin, 'greatping'));
    const runtimeBin = join(home, 'runtime/bin');
    mkdirSync(runtimeBin, { recursive: true });
    tool(runtimeBin, 'greatping');
    const childEnv = { ...env, PATH: `${runtimeBin}${delimiter}${bin}` };
    const installation = detectInstallation(script, childEnv);
    assert.equal(installation.manager, 'vite-plus');
    assert.equal(installation.updateCommand, 'vp install -g greatping@latest');
    assert.deepEqual(installation.removal.args, ['uninstall', '-g', 'greatping']);
    assert.equal(installation.launcher, join(bin, 'greatping'));
    const previous = [process.argv[1], process.env.PATH];
    try {
      process.argv[1] = script;
      process.env.PATH = childEnv.PATH;
      assert.deepEqual(currentLauncher(), { command: join(bin, 'greatping'), args: [] });
    } finally {
      [process.argv[1], process.env.PATH] = previous;
    }
    for (const value of [
      null,
      { ...metadata, installId: '../other' },
      { ...metadata, version: '2.0.0' },
    ]) {
      json(`${store}.json`, value);
      assert.equal(detectInstallation(script, env).manager, 'unknown');
      assert.equal(detectInstallation(script, env).removal, null);
    }
    json(`${store}.json`, metadata);
    rmSync(join(bin, 'greatping'));
    tool(bin, 'greatping');
    assert.equal(detectInstallation(script, env).manager, 'unknown');
  }));

test('project installs, checkouts, malformed manifests and missing managers are preserved', () =>
  sandbox(({ home, env }) => {
    for (const root of [join(home, 'project/node_modules/greatping'), join(home, 'checkout')]) {
      const script = entry(root);
      mkdirSync(join(root, 'src'));
      assert.equal(detectInstallation(script, env).manager, 'local');
      assert.equal(detectInstallation(script, env).removal, null);
      json(join(root, 'package.json'), { name: 'other', bin: { greatping: './dist/index.js' } });
      assert.equal(detectInstallation(script, env).manager, 'unknown');
    }
    const script = entry(join(home, 'prefix/lib/node_modules/greatping'));
    assert.equal(detectInstallation(script, env).manager, 'npm');
    assert.equal(detectInstallation(script, env).removal, null);
  }));

test('npm ownership preflight refuses the wrong root before any mutation', () =>
  sandbox(async ({ home, bin }) => {
    const root = join(home, 'prefix/lib/node_modules/greatping');
    const script = entry(root);
    const log = join(home, 'calls.json');
    tool(
      bin,
      'npm',
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(home)});`,
    );
    const previous = [process.argv[1], process.env.PATH];
    try {
      process.argv[1] = script;
      process.env.PATH = bin;
      await assert.rejects(verifyRemoval(detectInstallation()), /does not own/);
      assert.deepEqual(JSON.parse(readFileSync(log)), [
        'root',
        '--global',
        '--prefix',
        realpathSync(join(home, 'prefix')),
      ]);
      assert.ok(existsSync(root));
    } finally {
      [process.argv[1], process.env.PATH] = previous;
    }
  }));
