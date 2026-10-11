import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
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
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, api } from '../src/api.ts';
import { DEFAULT_API_URL } from '../src/config.ts';
import { detectInstallation, managerOutput, verifyRemoval } from '../src/installation.ts';
import { currentLauncher } from '../src/integrations/launcher.ts';
import { executeRemoval } from '../src/integrations/removal.ts';

test('cancellation stops a package-manager subprocess and skips remaining cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'greatping-removal-cancel-'));
  try {
    const ready = join(root, 'ready');
    const controller = new AbortController();
    const pending = managerOutput(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(()=>{},1000)`,
      ],
      10000,
      controller.signal,
    );
    const outcome = assert.rejects(pending);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await delay(10);
    assert.ok(existsSync(ready), 'The manager never started');
    const started = Date.now();
    controller.abort();
    await outcome;
    assert.ok(Date.now() - started < 2000, 'Cancellation waited for the manager deadline');
    const cleanup = new AbortController();
    let discardedPairing = false;
    await assert.rejects(
      executeRemoval(
        [
          { id: 'first', label: 'first', run: () => cleanup.abort() },
          {
            id: 'pairing',
            label: 'delete pairing',
            run: () => {
              discardedPairing = true;
            },
          },
        ],
        { signal: cleanup.signal },
      ),
      { name: 'AbortError' },
    );
    assert.equal(discardedPairing, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

async function outdatedAdvice(script, env, updateCommand) {
  const saved = [process.argv[1], process.env, globalThis.fetch];
  const hint = updateCommand
    ? `Update with ${updateCommand}`
    : 'Update this installation using its original package manager or source checkout.';
  try {
    process.argv[1] = script;
    process.env = { ...env };
    // Both old servers with hard-coded npm advice and future neutral/absent
    // messages must work. Detection must not perform a registry lookup.
    for (const message of [
      'this version of GreatPing is out of date; update it with npm install -g greatping@latest',
      'This version of the GreatPing CLI is no longer supported. Update GreatPing using your original package manager or installation method.',
      'upgrade required',
      undefined,
    ]) {
      for (const path of ['/pair/start', '/requests']) {
        let calls = 0;
        globalThis.fetch = async (url) => {
          calls++;
          assert.equal(url, `${DEFAULT_API_URL}/v1${path}`);
          return Response.json({ error: { code: 'client_outdated', message } }, { status: 426 });
        };
        await assert.rejects(
          api({ apiUrl: DEFAULT_API_URL }, 'POST', path, { token: null }),
          (error) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.status, 426);
            assert.equal(error.code, 'client_outdated');
            assert.equal(error.message, `This version of GreatPing is out of date. ${hint}`);
            assert.equal(error.message.includes(String.fromCharCode(27)), false);
            return true;
          },
        );
        assert.equal(calls, 1);
      }
    }
  } finally {
    [process.argv[1], process.env, globalThis.fetch] = saved;
  }
}

test('global manager evidence produces the correct update and removal commands', () =>
  sandbox(async ({ home, bin, env }) => {
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
      await outdatedAdvice(script, env, installation.updateCommand);
    }
  }));

test('Vite+ metadata and shared shim identify the selected installation and stable hook launcher', () =>
  sandbox(async ({ home, bin, env }) => {
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
    await outdatedAdvice(script, childEnv, 'vp install -g greatping@latest');
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
      await outdatedAdvice(script, env, null);
    }
    json(`${store}.json`, metadata);
    rmSync(join(bin, 'greatping'));
    tool(bin, 'greatping');
    assert.equal(detectInstallation(script, env).manager, 'unknown');
  }));

test('project installs, checkouts, malformed manifests and missing managers are preserved', () =>
  sandbox(async ({ home, env }) => {
    for (const root of [join(home, 'project/node_modules/greatping'), join(home, 'checkout')]) {
      const script = entry(root);
      mkdirSync(join(root, 'src'));
      assert.equal(detectInstallation(script, env).manager, 'local');
      assert.equal(detectInstallation(script, env).removal, null);
      await outdatedAdvice(script, env, null);
      json(join(root, 'package.json'), { name: 'other', bin: { greatping: './dist/index.js' } });
      assert.equal(detectInstallation(script, env).manager, 'unknown');
      await outdatedAdvice(script, env, null);
    }
    const script = entry(join(home, 'prefix/lib/node_modules/greatping'));
    assert.equal(detectInstallation(script, env).manager, 'npm');
    assert.equal(detectInstallation(script, env).removal, null);
  }));

test('built Vite+ login failures and update checks agree without executing a manager or saving pairing', () =>
  sandbox(({ home, bin, env }) => {
    const store = join(home, 'packages/greatping');
    const id = '2715ef2b-1831-40e2-9d40-69121bf6c137';
    const root = join(store, id, 'lib/node_modules/greatping');
    mkdirSync(root, { recursive: true });
    cpSync(new URL('../dist', import.meta.url), join(root, 'dist'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
    symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    json(`${store}.json`, { name: 'greatping', version, installId: id, bins: ['greatping'] });
    const managerLog = join(home, 'manager-called');
    const managerCode = `require('node:fs').writeFileSync(${JSON.stringify(managerLog)}, 'called')`;
    const vp = tool(bin, 'vp', managerCode);
    tool(bin, 'npm', managerCode);
    symlinkSync(vp, join(bin, 'greatping'));
    const preload = `
      globalThis.fetch = async (url) => {
        if (url === 'https://registry.npmjs.org/-/package/greatping/dist-tags')
          return Response.json({ latest: '99.0.0' });
        if (url !== ${JSON.stringify(`${DEFAULT_API_URL}/v1/pair/start`)})
          throw new Error('Unexpected hosted request');
        return Response.json({ error: { code: 'client_outdated',
          message: 'this version of GreatPing is out of date; update it with npm install -g greatping@latest'
        } }, { status: 426 });
      };
    `;
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`,
          join(root, 'dist/index.js'),
          ...args,
        ],
        {
          cwd: home,
          env: {
            ...env,
            XDG_CONFIG_HOME: join(home, '.config'),
            NO_COLOR: '1',
            NO_UPDATE_NOTIFIER: '1',
          },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
    const login = run('login');
    assert.equal(login.error, undefined);
    assert.equal(login.status, 1, login.stderr);
    assert.equal(login.stdout, '');
    assert.match(
      login.stderr,
      /This version of GreatPing is out of date\. Update with vp install -g greatping@latest/,
    );
    assert.doesNotMatch(login.stderr, /npm install|Pair this computer|greatping logout/);
    assert.equal(login.stderr.includes(String.fromCharCode(27)), false);
    assert.equal(existsSync(join(home, '.config/greatping/config.json')), false);
    const check = run('update', '--json');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stderr, '');
    assert.deepEqual(JSON.parse(check.stdout).installation, {
      manager: 'vite-plus',
      updateCommand: 'vp install -g greatping@latest',
    });
    const human = run('update');
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, '');
    assert.match(human.stderr, /Update with vp install -g greatping@latest/);
    assert.equal(existsSync(managerLog), false);
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
