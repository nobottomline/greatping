import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeSteps } from '../src/integrations/events.ts';

const cli =
  process.env.GREATPING_TEST_CLI ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const node = process.env.GREATPING_TEST_NODE ?? process.execPath;

test('native lifecycle correlates prompts, resolves cancellation and requires finished opt-in', () => {
  const input = { session_id: 'session', correlation: 'permission:1', reason: 'permission' };
  assert.deepEqual(nativeSteps({ ...input, hook_event_name: 'PromptOpen' }, { finished: false }), [
    { op: 'notify', correlation: 'permission:1', reason: 'permission' },
  ]);
  assert.deepEqual(nativeSteps({ ...input, hook_event_name: 'PromptClose' }, { finished: false }), [
    { op: 'resolve', correlation: 'permission:1' },
  ]);
  for (const hook_event_name of ['Started', 'SessionEnd', 'Finished'])
    assert.deepEqual(nativeSteps({ ...input, hook_event_name }, { finished: false }), [
      { op: 'resolve-session' },
    ]);
  assert.equal(
    nativeSteps({ ...input, hook_event_name: 'Finished' }, { finished: true })[1].reason,
    'finished',
  );
  assert.deepEqual(
    nativeSteps(
      { ...input, reason: 'private command', hook_event_name: 'PromptOpen' },
      { finished: true },
    ),
    [],
  );
});

test('OpenCode setup is offline, repeatable, preserves config and refuses modified ownership', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'greatping native ownership '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
    PATH: join(root, 'bin'),
    CI: '1',
    NO_COLOR: '1',
  };
  mkdirSync(env.PATH);
  if (process.platform === 'win32') copyFileSync(node, join(env.PATH, 'node.exe'));
  else symlinkSync(node, join(env.PATH, 'node'));
  mkdirSync(env.OPENCODE_CONFIG_DIR);
  const config = join(env.OPENCODE_CONFIG_DIR, 'opencode.jsonc');
  const original = '{ // preserve my comment\n "foreign": true\n}\n';
  writeFileSync(config, original);
  const invoke = (args) =>
    spawnSync(node, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(invoke(['setup', 'opencode']).status, 1);
  if (process.platform !== 'win32') {
    const host = join(root, 'host.mjs');
    writeFileSync(host, "console.log('1.18.33');\n", { mode: 0o755 });
    symlinkSync(host, join(env.PATH, 'opencode'));
    const incompatible = invoke(['setup', 'opencode', '--yes']);
    assert.equal(incompatible.status, 1);
    assert.match(incompatible.stderr + incompatible.stdout, /requires OpenCode >=1.18.34/);
    assert.equal(readFileSync(config, 'utf8'), original);
    rmSync(join(env.PATH, 'opencode'));
  }
  for (let i = 0; i < 2; i++) {
    const result = invoke(['setup', 'opencode', '--yes', '--no-finished']);
    assert.equal(result.status, 0, result.stderr);
  }
  const status = JSON.parse(invoke(['status', '--json']).stdout);
  assert.equal(status.plugins.find((p) => p.id === 'opencode').status, 'ready');
  assert.equal(status.plugins.find((p) => p.id === 'opencode').finished, false);
  assert.equal(readFileSync(config, 'utf8'), original);
  // Global migration still targets legacy integrations even with native hosts.
  const migration = invoke(['setup', '--migrate', '--yes']);
  assert.match(migration.stderr + migration.stdout, /requires an installed GreatPing plugin/);
  assert.doesNotMatch(migration.stderr + migration.stdout, /for Claude\/Codex direct/);
  const prefs = join(env.XDG_CONFIG_HOME, 'greatping/plugins/opencode.json');
  const preferences = JSON.parse(readFileSync(prefs, 'utf8'));
  writeFileSync(prefs, JSON.stringify({ ...preferences, launcher: { command: node, args: [42] } }));
  assert.equal(
    JSON.parse(invoke(['status', '--json']).stdout).plugins.find((p) => p.id === 'opencode').status,
    'broken',
  );
  invoke(['doctor', '--fix']);
  assert.equal(
    JSON.parse(invoke(['status', '--json']).stdout).plugins.find((p) => p.id === 'opencode').status,
    'ready',
  );
  const entry = join(env.OPENCODE_CONFIG_DIR, 'plugins', 'greatping.js');
  writeFileSync(entry, '// user edited this adapter\n');
  assert.equal(invoke(['setup', 'opencode', '--yes']).status, 1);
  assert.equal(invoke(['setup', 'opencode', '--remove', '--yes']).status, 1);
  assert.equal(readFileSync(entry, 'utf8'), '// user edited this adapter\n');
  assert.equal(readFileSync(config, 'utf8'), original);
  if (process.platform !== 'win32') {
    rmSync(entry);
    const foreign = join(root, 'foreign-target.js');
    symlinkSync(foreign, entry);
    assert.equal(invoke(['setup', 'opencode', '--yes']).status, 1);
    assert.equal(invoke(['setup', 'opencode', '--remove', '--yes']).status, 1);
    assert.equal(existsSync(foreign), false, 'A broken foreign link was not followed');
  }
});

test('removing a managed OpenCode skill preserves other hosts and the canonical skill', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'greatping native skill scope '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const opencode = join(root, 'opencode');
  const claude = join(root, '.claude');
  const canonical = join(root, '.agents/skills/greatping');
  for (const path of [bin, canonical, join(opencode, 'skills'), join(claude, 'skills')])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(canonical, 'SKILL.md'), '---\nname: greatping\n---\n');
  writeFileSync(
    join(root, '.agents/.skill-lock.json'),
    JSON.stringify({ version: 3, skills: { greatping: { source: 'nobottomline/greatping' } } }),
  );
  symlinkSync(canonical, join(opencode, 'skills/greatping'));
  symlinkSync(canonical, join(claude, 'skills/greatping'));
  writeFileSync(
    join(bin, 'npx'),
    `#!${node}\nconst fs=require('node:fs'),path=require('node:path');
if(process.argv.at(-1)!=='opencode') process.exit(1);
fs.unlinkSync(path.join(process.env.OPENCODE_CONFIG_DIR,'skills/greatping'));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(node, [cli, 'setup', 'opencode', '--remove', '--yes'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: '',
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(root, '.codex'),
      OPENCODE_CONFIG_DIR: opencode,
      PI_CODING_AGENT_DIR: join(root, 'pi'),
      PATH: bin,
      CI: '1',
      NO_COLOR: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(opencode, 'skills/greatping')), false);
  assert.equal(existsSync(join(claude, 'skills/greatping')), true);
  assert.equal(existsSync(join(canonical, 'SKILL.md')), true);
});

test('Cursor local plugin setup is offline, repeatable and preserves foreign configuration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'greatping cursor ownership '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    PATH: join(root, 'bin'),
    CI: '1',
    NO_COLOR: '1',
  };
  mkdirSync(env.PATH);
  if (process.platform === 'win32') copyFileSync(node, join(env.PATH, 'node.exe'));
  else symlinkSync(node, join(env.PATH, 'node'));
  mkdirSync(join(root, '.cursor'));
  const foreign = join(root, '.cursor/hooks.json');
  const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: 'foreign-hook' }] } });
  writeFileSync(foreign, original);
  const invoke = (args) =>
    spawnSync(node, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
  for (let i = 0; i < 2; i++) {
    const result = invoke(['setup', 'cursor', '--yes']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  const plugin = JSON.parse(invoke(['status', '--json']).stdout).plugins.find(
    (p) => p.id === 'cursor',
  );
  assert.equal(plugin.status, 'ready');
  assert.equal(plugin.finished, true);
  assert.deepEqual(plugin.alerts, []);
  assert.equal(readFileSync(foreign, 'utf8'), original);
  const manifest = join(root, '.cursor/plugins/local/greatping/.cursor-plugin/plugin.json');
  assert.ok(existsSync(manifest));
  const removal = invoke(['setup', 'cursor', '--remove', '--yes']);
  assert.equal(removal.status, 0, removal.stderr + removal.stdout);
  assert.equal(existsSync(manifest), false);
  assert.equal(readFileSync(foreign, 'utf8'), original);
  assert.equal(invoke(['setup', 'cursor', '--yes']).status, 0);
  writeFileSync(manifest, '{"name":"user-modified"}');
  assert.equal(invoke(['setup', 'cursor', '--yes']).status, 1);
  assert.equal(invoke(['setup', 'cursor', '--remove', '--yes']).status, 1);
  assert.equal(JSON.parse(readFileSync(manifest)).name, 'user-modified');
});
