import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_API_URL } from '../src/config.ts';
import { HOSTS, inspectHooks, installHooks } from '../src/integrations/host-hooks.ts';
import { fingerprint, recordAsset } from '../src/integrations/ownership.ts';
import { installSkill } from '../src/integrations/skill.ts';

const cli = new URL('../dist/index.js', import.meta.url).pathname;
const fixtureFetch = new URL('./fixtures/operations-fetch.mjs', import.meta.url).pathname;
function json(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function script(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
}
function hashes(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path] = fingerprint(path);
    }
  };
  walk(root);
  return files;
}
async function home(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-remove-'));
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  process.env.CODEX_HOME = join(root, '.codex');
  delete process.env.XDG_STATE_HOME;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const env = {
    ...process.env,
    PATH: bin,
    NO_COLOR: '1',
    CI: '1',
    GREATPING_TEST_LOG: join(root, 'network.jsonl'),
  };
  const exec = (args, mode = 'answered') =>
    spawnSync(process.execPath, ['--import', fixtureFetch, cli, ...args], {
      env: { ...env, GREATPING_TEST_MODE: mode },
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    await run({ root, bin, env, exec });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
function integrations(root, bin) {
  const foreign = {
    hooks: [{ type: 'command', command: 'other-agent', args: ['hook', 'claude'] }],
  };
  json(HOSTS.claude.settingsPath(), { model: 'opus', hooks: { Stop: [foreign] } });
  installHooks(HOSTS.claude, { command: process.execPath, args: [cli] }, true);
  installHooks(HOSTS.codex, { command: process.execPath, args: [cli] }, true);
  installSkill('claude');
  installSkill('codex');
  const codexFile = join(root, '.codex', 'config.toml');
  writeFileSync(
    codexFile,
    `[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.greatping]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cli, 'mcp'])}\n`,
  );
  recordAsset({
    kind: 'mcp',
    path: codexFile,
    host: 'codex',
    launcher: { command: process.execPath, args: [cli, 'mcp'] },
  });
  script(
    join(bin, 'codex'),
    `const fs=require('node:fs'), path=require('node:path'); const file=path.join(process.env.CODEX_HOME,'config.toml'); if(process.env.REMOVE_FAIL==='1') process.exit(1); fs.writeFileSync(file, fs.readFileSync(file,'utf8').replace(/\\[mcp_servers\\.greatping\\][\\s\\S]*?(?=\\n\\[|$)/, ''));`,
  );
  return foreign;
}
function pair(root) {
  json(join(root, '.config', 'greatping', 'config.json'), {
    apiUrl: DEFAULT_API_URL,
    machineId: 'test-machine',
    machineToken: 'PRIVATE TOKEN',
  });
}

function installedPackage(packageRoot) {
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  cpSync(new URL('../dist', import.meta.url), join(packageRoot, 'dist'), { recursive: true });
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  json(join(packageRoot, 'package.json'), manifest);
  symlinkSync(
    new URL('../node_modules', import.meta.url).pathname,
    join(packageRoot, 'node_modules'),
  );
  return manifest;
}

test('dry-run plans every installed component without writes, manager calls or network', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    pair(root);
    const before = hashes(root);
    const result = exec(['uninstall', '--dry-run', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.ok(plan.actions.some((a) => a.id === 'pairing'));
    assert.ok(plan.actions.some((a) => a.id.startsWith('skill:')));
    assert.deepEqual(hashes(root), before);
    assert.doesNotMatch(result.stdout, /PRIVATE TOKEN/);
  }));
test('uninstall preserves foreign hooks, MCP and files, revokes pairing and is repeatable', async () =>
  home(({ root, bin, exec }) => {
    const foreign = integrations(root, bin);
    pair(root);
    const updateCache = join(root, '.config', 'greatping', 'update-check.json');
    json(updateCache, { latest: '99.0.0', attemptedAt: Date.now(), checkedAt: Date.now() });
    json(join(root, '.claude.json'), {
      preferences: { theme: 'dark' },
      mcpServers: {
        other: { command: 'other' },
        greatping: { command: 'greatping', args: ['mcp'] },
      },
    });
    writeFileSync(join(root, '.config', 'greatping', 'user-notes.txt'), 'Keep me');
    const result = exec(['uninstall', '--yes', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).complete, true);
    assert.equal(existsSync(updateCache), false);
    assert.deepEqual(JSON.parse(readFileSync(HOSTS.claude.settingsPath(), 'utf8')), {
      model: 'opus',
      hooks: { Stop: [foreign] },
    });
    assert.equal(inspectHooks(HOSTS.codex).status, 'off');
    assert.match(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), /mcp_servers.other/);
    assert.doesNotMatch(
      readFileSync(join(root, '.codex', 'config.toml'), 'utf8'),
      /mcp_servers.greatping/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf8')), {
      preferences: { theme: 'dark' },
      mcpServers: { other: { command: 'other' } },
    });
    assert.equal(existsSync(join(root, '.claude', 'settings.json.greatping-backup')), false);
    assert.equal(existsSync(join(root, '.claude.json.greatping-backup')), false);
    assert.equal(
      readFileSync(join(root, '.config', 'greatping', 'user-notes.txt'), 'utf8'),
      'Keep me',
    );
    assert.equal(existsSync(join(root, '.config', 'greatping', 'config.json')), false);
    assert.equal(exec(['uninstall', '--yes']).status, 0);
  }));
test('non-interactive uninstall requires explicit confirmation', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    const before = hashes(root);
    const result = exec(['uninstall']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--yes/);
    assert.deepEqual(hashes(root), before);
  }));
test('modified skills are preserved and prevent final cleanup until the conflict is resolved', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    const file = join(root, '.claude', 'skills', 'greatping', 'SKILL.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nUser notes\n`);
    const result = exec(['uninstall', '--yes', '--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).complete, false);
    assert.match(readFileSync(file, 'utf8'), /User notes/);
    assert.ok(existsSync(join(root, '.config', 'greatping', 'installation.json')));
  }));
test('failed Codex removal is reported by setup --remove and can be retried', async () =>
  home(({ root, bin, env, exec }) => {
    integrations(root, bin);
    env.REMOVE_FAIL = '1';
    const result = exec(['setup', '--remove', '--yes']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      readFileSync(join(root, '.codex', 'config.toml'), 'utf8'),
      /mcp_servers.greatping/,
    );
    delete env.REMOVE_FAIL;
    assert.equal(exec(['setup', '--remove', '--yes']).status, 0);
  }));
test('offline uninstall preserves credential; local-only removal explicitly skips revocation', async () =>
  home(({ root, exec }) => {
    pair(root);
    const config = join(root, '.config', 'greatping', 'config.json');
    assert.equal(exec(['uninstall', '--yes', '--json'], 'network').status, 1);
    assert.ok(existsSync(config));
    const result = exec(['uninstall', '--yes', '--local-only', '--json'], 'network');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).serverRevocation, 'skipped');
    assert.equal(existsSync(config), false);
  }));
test('uninstall preserves unknown MCP ownership', async () =>
  home(({ root, exec }) => {
    json(join(root, '.claude.json'), {
      mcpServers: { greatping: { command: 'other-program', args: ['mcp'] } },
    });
    const before = readFileSync(join(root, '.claude.json'), 'utf8');
    const result = exec(['uninstall', '--yes']);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(join(root, '.claude.json'), 'utf8'), before);
  }));
test('uninstall uses the skills manager and detects a manager that reports success without removing', async () =>
  home(({ root, bin, exec }) => {
    const canonical = join(root, '.agents', 'skills', 'greatping');
    json(join(root, '.agents', '.skill-lock.json'), {
      version: 3,
      skills: { greatping: { source: 'nobottomline/greatping' }, other: { source: 'other/repo' } },
    });
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'SKILL.md'), '---\nname: greatping\n---\n');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.claude', 'skills', 'greatping'));
    script(
      join(bin, 'npx'),
      `const fs=require('node:fs'), path=require('node:path'); fs.writeFileSync(path.join(process.env.HOME,'npx-args.json'),JSON.stringify(process.argv.slice(2)));`,
    );
    const result = exec(['uninstall', '--yes']);
    assert.equal(result.status, 1);
    const args = JSON.parse(readFileSync(join(root, 'npx-args.json'), 'utf8'));
    assert.deepEqual(args, ['--yes', 'skills@1.7.0', 'remove', 'greatping', '--global', '--yes']);
    assert.ok(existsSync(canonical));
  }));
test('uninstall preserves changed backups and corrupt ownership records', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    const backup = `${HOSTS.claude.settingsPath()}.greatping-backup`;
    writeFileSync(backup, 'User backup');
    assert.equal(exec(['uninstall', '--yes']).status, 1);
    assert.equal(readFileSync(backup, 'utf8'), 'User backup');
    const record = join(root, '.config', 'greatping', 'installation.json');
    writeFileSync(record, '{broken');
    const before = hashes(root);
    assert.equal(exec(['uninstall', '--yes']).status, 1);
    assert.deepEqual(hashes(root), before);
  }));

test('global npm removal runs last and verifies the running package root', async () =>
  home(({ root, bin, env }) => {
    const modules = join(root, 'global', 'lib', 'node_modules');
    const packageRoot = join(modules, 'greatping');
    installedPackage(packageRoot);
    pair(root);
    env.TEST_MODULES = modules;
    script(
      join(bin, 'npm'),
      `const fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2); fs.appendFileSync(path.join(process.env.HOME,'npm-calls.jsonl'),JSON.stringify(args)+'\\n'); if(args[0]==='root') console.log(process.env.TEST_MODULES); else { if(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME,'greatping','config.json'))) process.exit(4); fs.rmSync(path.join(process.env.TEST_MODULES,'greatping'),{recursive:true}); }`,
    );
    const execute = (args) =>
      spawnSync(
        process.execPath,
        ['--import', fixtureFetch, join(packageRoot, 'dist', 'index.js'), ...args],
        { env, encoding: 'utf8', timeout: 10000 },
      );
    const before = hashes(root);
    assert.equal(execute(['uninstall', '--dry-run']).status, 0);
    assert.deepEqual(hashes(root), before);
    const result = execute(['uninstall', '--yes', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(packageRoot), false);
    assert.deepEqual(
      readFileSync(join(root, 'npm-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
      [
        ['root', '--global', '--prefix', realpathSync(join(root, 'global'))],
        ['root', '--global', '--prefix', realpathSync(join(root, 'global'))],
        [
          'uninstall',
          '--global',
          '--prefix',
          realpathSync(join(root, 'global')),
          'greatping',
          '--ignore-scripts',
        ],
      ],
    );
  }));

test('a mismatched global manager preserves pairing and performs no server revocation', async () =>
  home(({ root, bin, env }) => {
    const packageRoot = join(root, 'global/lib/node_modules/greatping');
    installedPackage(packageRoot);
    pair(root);
    script(join(bin, 'npm'), `console.log(${JSON.stringify(root)});`);
    const config = join(root, '.config/greatping/config.json');
    const before = readFileSync(config, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        fixtureFetch,
        join(packageRoot, 'dist/index.js'),
        'uninstall',
        '--yes',
        '--json',
      ],
      { env, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).serverRevocation, 'not-attempted');
    assert.equal(JSON.parse(result.stdout).complete, false);
    assert.equal(readFileSync(config, 'utf8'), before);
    assert.equal(existsSync(env.GREATPING_TEST_LOG), false);
    assert.ok(existsSync(packageRoot));
  }));

test('Vite+ removal uses the recorded owner, runs last and never calls npm', async () =>
  home(({ root, bin, env }) => {
    const store = join(root, 'vite-data/packages/greatping');
    const installId = '2715ef2b-1831-40e2-9d40-69121bf6c137';
    const packageRoot = join(store, installId, 'lib/node_modules/greatping');
    const manifest = installedPackage(packageRoot);
    json(`${store}.json`, {
      name: 'greatping',
      installId,
      version: manifest.version,
      bins: ['greatping'],
    });
    pair(root);
    env.TEST_PACKAGE_ROOT = packageRoot;
    script(
      join(bin, 'vp'),
      `const fs=require('node:fs'),path=require('node:path');
      fs.writeFileSync(path.join(process.env.HOME,'vp-calls.json'),JSON.stringify(process.argv.slice(2)));
      if(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME,'greatping/config.json'))) process.exit(4);
      fs.rmSync(process.env.TEST_PACKAGE_ROOT,{recursive:true});`,
    );
    symlinkSync(join(bin, 'vp'), join(bin, 'greatping'));
    script(join(bin, 'npm'), 'process.exit(9);');
    const execute = (args) =>
      spawnSync(
        process.execPath,
        ['--import', fixtureFetch, join(packageRoot, 'dist/index.js'), ...args],
        { env, encoding: 'utf8', timeout: 10000 },
      );
    const before = hashes(root);
    const preview = execute(['uninstall', '--dry-run', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).packageManager, 'vite-plus');
    assert.deepEqual(hashes(root), before);
    const result = execute(['uninstall', '--yes', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).complete, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'vp-calls.json'))), [
      'uninstall',
      '-g',
      'greatping',
    ]);
    assert.equal(existsSync(packageRoot), false);
  }));

test('an already revoked computer can finish uninstall', async () =>
  home(({ root, exec }) => {
    pair(root);
    const result = exec(['uninstall', '--yes', '--json'], 'revoked');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).serverRevocation, 'revoked');
  }));

test('dry-run exposes a modified skill conflict and setup does not overwrite it', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    const path = join(root, '.agents', 'skills', 'greatping', 'SKILL.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nLocal changes\n`);
    const before = hashes(root);
    const result = exec(['uninstall', '--dry-run', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).actions.some((a) => a.problem?.includes('files changed')));
    assert.deepEqual(hashes(root), before);
    assert.throws(() => installSkill('codex'), /was changed/);
    assert.match(readFileSync(path, 'utf8'), /Local changes/);
  }));

test('unknown pairing prevents silent credential deletion and is visible in the plan', async () =>
  home(({ root, exec }) => {
    const config = join(root, '.config', 'greatping', 'config.json');
    json(config, {});
    writeFileSync(config, '{unreadable');
    const preview = exec(['uninstall', '--dry-run', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.ok(
      JSON.parse(preview.stdout).actions.some(
        (action) => action.id === 'pairing' && action.problem,
      ),
    );
    const result = exec(['uninstall', '--yes', '--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(config, 'utf8'), '{unreadable');
    assert.equal(JSON.parse(result.stdout).serverRevocation, 'failed');
    assert.equal(exec(['uninstall', '--yes', '--local-only']).status, 0);
  }));

test('local cleanup failure preserves the ownership journal for a retry', async () =>
  home(({ root, bin, exec }) => {
    integrations(root, bin);
    const preferences = join(root, '.config', 'greatping', 'setup-options.json');
    writeFileSync(preferences, '{}');
    const result = exec(['uninstall', '--yes', '--json'], 'cleanup-fail');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).complete, false);
    assert.ok(existsSync(join(root, '.config', 'greatping', 'installation.json')));
    assert.ok(existsSync(preferences));
    assert.equal(exec(['uninstall', '--yes']).status, 0);
  }));
