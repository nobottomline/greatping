import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'plugins/shared/bridge.mjs');
const fixtureSource = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(process.env.FIXTURE_VERSION || '0.4.0');
  process.exit(0);
}
if (args[0] === 'runtime-health') { console.log(JSON.stringify({problem: process.env.FIXTURE_PAIRING_PROBLEM || null})); process.exit(0); }
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args, pid:process.pid})+'\\n');
if (process.env.FIXTURE_HANG === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({input})+'\\n');
  process.stdout.write('fixture output');
  process.stderr.write('fixture diagnostic');
  process.exit(Number(process.env.FIXTURE_EXIT || 0));
}
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'greatping plugin '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin with spaces');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const codex = join(home, '.codex');
  for (const path of [bin, home, codex]) mkdirSync(path, { recursive: true });
  const script = join(root, 'fixture-cli.mjs');
  const log = join(root, 'calls.jsonl');
  writeFileSync(script, fixtureSource, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(script, join(bin, 'greatping'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: '',
    PATH: bin,
    FIXTURE_LOG: log,
    FIXTURE_VERSION: '0.4.0',
    FIXTURE_HANG: '',
    FIXTURE_EXIT: '',
    GREATPING_DISABLE: '',
    NO_UPDATE_NOTIFIER: '1',
  };
  const run = (host, mode, args = [], overrides = {}) =>
    spawnSync(process.execPath, [source, host, mode, ...args], {
      env: { ...env, ...overrides },
      input: overrides.input ?? '',
      encoding: 'utf8',
      timeout: 12_000,
    });
  const settings = (host) => join(config, 'greatping/plugins', `${host}.json`);
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, bin, home, config, codex, env, script, log, run, settings, write, calls };
}

test('generated packages contain their canonical skill and launcher and valid contained paths', (t) => {
  const f = fixture(t);
  const generated = spawnSync(
    process.execPath,
    ['scripts/build-agent-plugins.mjs', '--output', f.root],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const current = spawnSync(process.execPath, ['scripts/build-agent-plugins.mjs', '--check'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);
  for (const host of ['claude', 'codex']) {
    const pkg = join(f.root, 'plugins', host, 'greatping');
    assert.equal(
      readFileSync(join(pkg, 'scripts/bridge.mjs'), 'utf8'),
      readFileSync(source, 'utf8'),
    );
    assert.equal(
      readFileSync(join(pkg, 'skills/greatping/SKILL.md'), 'utf8'),
      readFileSync(join(repo, 'skills/greatping/SKILL.md'), 'utf8'),
    );
    const hooks = JSON.parse(readFileSync(join(pkg, 'hooks/hooks.json'), 'utf8')).hooks;
    assert.equal(hooks.Stop[0].hooks[0].async, undefined);
    assert.equal(hooks.SessionEnd[0].hooks[0].async, undefined);
    if (host === 'codex') assert.equal(hooks.PermissionRequest, undefined);
    else assert.equal(hooks.PreToolUse[0].matcher, 'AskUserQuestion');
    assert.ok(existsSync(join(pkg, 'LICENSE')));
  }
  for (const host of ['opencode', 'pi']) {
    const pkg = join(f.root, 'plugins', host, 'greatping');
    const metadata = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    assert.equal(metadata.name, `@greatping/${host}`);
    assert.equal(metadata.type, 'module');
    assert.equal(metadata.dependencies, undefined, 'Pi dependencies are provided by its host');
    for (const [generatedFile, canonical] of [
      ['index.js', `plugins/shared/${host}.js`],
      ['bridge.mjs', 'plugins/shared/bridge.mjs'],
      ['native.mjs', 'plugins/shared/native.mjs'],
      ['skills/greatping/SKILL.md', 'skills/greatping/SKILL.md'],
    ])
      assert.equal(
        readFileSync(join(pkg, generatedFile), 'utf8'),
        readFileSync(join(repo, canonical), 'utf8'),
      );
    if (host === 'pi') {
      assert.deepEqual(metadata.pi, { extensions: ['./index.js'], skills: ['./skills'] });
      assert.ok(metadata.keywords.includes('pi-package'));
    } else assert.equal(metadata.main, './index.js');
  }
  const catalog = JSON.parse(readFileSync(join(f.root, '.agents/plugins/marketplace.json')));
  assert.ok(existsSync(join(f.root, catalog.plugins[0].source.path, 'plugin.json')));
  const claude = JSON.parse(readFileSync(join(f.root, '.claude-plugin/marketplace.json')));
  assert.ok(existsSync(join(f.root, claude.plugins[0].source, '.claude-plugin/plugin.json')));
});

test('configuration preserves pairing, defaults and completion opt-in across package cache updates', (t) => {
  const f = fixture(t);
  const pairing = join(f.config, 'greatping/config.json');
  f.write(pairing, '{"fixture":"unchanged"}\n');
  assert.equal(f.run('claude', 'configure').status, 0);
  assert.equal(JSON.parse(readFileSync(f.settings('claude'))).finished, false);
  assert.equal(f.run('claude', 'configure', ['--finished']).status, 0);
  assert.equal(f.run('claude', 'configure').status, 0);
  assert.equal(JSON.parse(readFileSync(f.settings('claude'))).finished, true);
  assert.equal(f.run('codex', 'configure').status, 0);
  assert.equal(JSON.parse(readFileSync(f.settings('codex'))).finished, true);
  const copied = join(f.root, 'new cache with spaces/bridge.mjs');
  mkdirSync(dirname(copied), { recursive: true });
  cpSync(source, copied);
  const result = spawnSync(process.execPath, [copied, 'claude', 'check'], {
    env: f.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const alias = join(f.root, 'cache alias');
  symlinkSync(dirname(copied), alias, 'dir');
  const throughAlias = spawnSync(process.execPath, [join(alias, 'bridge.mjs'), 'claude', 'check'], {
    env: f.env,
    encoding: 'utf8',
  });
  assert.equal(throughAlias.status, 0, throughAlias.stderr);
  assert.match(throughAlias.stderr, /launcher ready/);
  assert.equal(readFileSync(pairing, 'utf8'), '{"fixture":"unchanged"}\n');
  if (process.platform !== 'win32')
    assert.equal(statSync(f.settings('claude')).mode & 0o777, 0o600);
});

test('saved stable launcher survives a sparse PATH and forwards stdin and preference flags silently', (t) => {
  const f = fixture(t);
  assert.equal(f.run('claude', 'configure', ['--finished']).status, 0);
  const payload = '{"session_id":"local-fixture","hook_event_name":"Stop"}\n';
  const result = f.run('claude', 'hook', [], { PATH: '', input: payload, FIXTURE_EXIT: '7' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(f.calls()[0].args, [
    'hook',
    'claude',
    '--finished',
    '--alerts',
    'questions,permissions,tool-input',
  ]);
  assert.equal(f.calls()[1].input, payload);
});

test('legacy exec and quoted shell handlers suppress plugin hooks and retain selected options', (t) => {
  for (const host of ['claude', 'codex']) {
    const f = fixture(t);
    const path =
      host === 'claude' ? join(f.home, '.claude/settings.json') : join(f.codex, 'hooks.json');
    const handler =
      host === 'claude'
        ? {
            command: join(f.bin, 'greatping'),
            args: ['hook', host, '--finished', '--alerts', 'questions'],
          }
        : { command: `'${join(f.bin, 'greatping')}' hook '${host}' --finished` };
    f.write(path, { hooks: { Stop: [{ hooks: [handler, { command: 'foreign-hook' }] }] } });
    const before = readFileSync(path, 'utf8');
    assert.equal(f.run(host, 'configure').status, 0);
    assert.equal(JSON.parse(readFileSync(f.settings(host))).finished, true);
    if (host === 'claude')
      assert.deepEqual(JSON.parse(readFileSync(f.settings(host))).alerts, ['questions']);
    assert.equal(f.run(host, 'hook', [], { input: 'private fixture' }).status, 0);
    assert.deepEqual(f.calls(), []);
    assert.match(f.run(host, 'check').stderr, /CLI hooks/);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('foreign handlers do not suppress plugin hooks and are never changed', (t) => {
  const f = fixture(t);
  const path = join(f.home, '.claude/settings.json');
  f.write(path, { hooks: { Stop: [{ hooks: [{ command: 'echo greatping hook claude' }] }] } });
  const before = readFileSync(path, 'utf8');
  assert.equal(f.run('claude', 'configure').status, 0);
  assert.equal(f.run('claude', 'hook').status, 0);
  assert.equal(f.calls().length, 2);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('recorded custom launchers suppress duplicate hooks independently of their directory name', (t) => {
  for (const host of ['claude', 'codex']) {
    const f = fixture(t);
    const path =
      host === 'claude' ? join(f.home, '.claude/settings.json') : join(f.codex, 'hooks.json');
    const launcher = { command: join(f.bin, 'node'), args: [f.script] };
    const handler =
      host === 'claude'
        ? {
            command: launcher.command,
            args: [...launcher.args, 'hook', host, '--finished', '--alerts', 'questions'],
          }
        : { command: `'${launcher.command}' '${f.script}' hook '${host}' --finished` };
    f.write(path, { hooks: { Stop: [{ hooks: [handler] }] } });
    const journal = join(f.config, 'greatping/installation.json');
    f.write(journal, { version: 1, assets: [{ kind: 'hooks', host, path, launcher }] });
    assert.equal(f.run(host, 'configure').status, 0);
    assert.equal(f.run(host, 'check').status, 1);
    assert.equal(JSON.parse(readFileSync(f.settings(host))).finished, true);
    assert.equal(f.run(host, 'hook').status, 0);
    assert.deepEqual(f.calls(), []);
    // Another script using the same Node executable is not the recorded CLI.
    f.write(journal, {
      version: 1,
      assets: [
        {
          kind: 'hooks',
          host,
          path,
          launcher: { ...launcher, args: [join(f.root, 'foreign.mjs')] },
        },
      ],
    });
    assert.equal(f.run(host, 'check').status, 0);
    assert.equal(f.run(host, 'hook').status, 0);
    assert.equal(f.calls().length, 2);
  }
});

test('MCP conflicts refuse a second server without overwriting configuration or emitting protocol noise', (t) => {
  for (const host of ['claude', 'codex']) {
    const f = fixture(t);
    assert.equal(f.run(host, 'configure').status, 0);
    const path = host === 'claude' ? join(f.home, '.claude.json') : join(f.codex, 'config.toml');
    f.write(
      path,
      host === 'claude'
        ? { mcpServers: { greatping: { command: 'foreign-server' } } }
        : '[mcp_servers."greatping"] # user registration\ncommand = "foreign-server"\n',
    );
    const before = readFileSync(path, 'utf8');
    const result = f.run(host, 'mcp');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /separately registered/);
    assert.deepEqual(f.calls(), []);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('hooks fail open for missing, corrupt or missing-launcher settings and disclose no private JSON', (t) => {
  const f = fixture(t);
  assert.equal(f.run('claude', 'hook').status, 0);
  assert.equal(f.run('claude', 'mcp').status, 1);
  f.write(f.settings('claude'), '{"fixture_private_value":"sensitive-example",broken');
  for (const mode of ['hook', 'check', 'mcp']) {
    const result = f.run('claude', mode);
    assert.equal(result.status, mode === 'hook' ? 0 : 1);
    assert.doesNotMatch(result.stderr + result.stdout, /sensitive-example/);
    assert.equal(result.stdout, '');
  }
  rmSync(f.settings('claude'));
  assert.equal(f.run('claude', 'configure').status, 0);
  rmSync(join(f.bin, 'node'));
  assert.equal(f.run('claude', 'hook').status, 0);
  assert.equal(f.run('claude', 'check').status, 1);
});

test('incompatible CLI versions and runtime-specific launcher paths are refused without saving', (t) => {
  const f = fixture(t);
  for (const version of ['0.3.3', '1.0.0', '0.4.0-preview', 'unexpected']) {
    assert.equal(f.run('claude', 'configure', [], { FIXTURE_VERSION: version }).status, 1);
    assert.equal(existsSync(f.settings('claude')), false);
  }
  const result = f.run('claude', 'configure', ['--command', join(f.root, 'v24.1.0/node')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /survives runtime updates/);
});

test('MCP forwards output and exit status; hook opt-out invokes no CLI', (t) => {
  const f = fixture(t);
  assert.equal(f.run('codex', 'configure').status, 0);
  const result = f.run('codex', 'mcp', [], { input: 'protocol fixture\n', FIXTURE_EXIT: '7' });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'fixture output');
  assert.equal(result.stderr, 'fixture diagnostic');
  assert.deepEqual(f.calls()[0].args, ['mcp']);
  rmSync(f.log);
  assert.equal(f.run('codex', 'hook', [], { GREATPING_DISABLE: '1' }).status, 0);
  assert.deepEqual(f.calls(), []);
});

test('hook deadline kills an unresponsive CLI without failing the host', (t) => {
  const f = fixture(t);
  assert.equal(f.run('codex', 'configure').status, 0);
  const start = Date.now();
  const result = f.run('codex', 'hook', [], { FIXTURE_HANG: '1' });
  assert.equal(result.status, 0);
  assert.ok(Date.now() - start < 10_000);
  assert.equal(result.stdout + result.stderr, '');
  assert.throws(() => process.kill(f.calls()[0].pid, 0));
});

test('terminating MCP also terminates an unresponsive child', async (t) => {
  const f = fixture(t);
  assert.equal(f.run('codex', 'configure').status, 0);
  const bridge = spawn(process.execPath, [source, 'codex', 'mcp'], {
    env: { ...f.env, FIXTURE_HANG: '1' },
    stdio: 'pipe',
  });
  t.after(() => bridge.kill('SIGKILL'));
  for (let i = 0; i < 100 && !existsSync(f.log); i++)
    await new Promise((done) => setTimeout(done, 20));
  assert.ok(existsSync(f.log));
  const closed = once(bridge, 'close');
  bridge.kill('SIGTERM');
  await closed;
  assert.throws(() => process.kill(f.calls()[0].pid, 0));
});

test('native adapters reject a released CLI without adapter capabilities', (t) => {
  const f = fixture(t);
  for (const host of ['opencode', 'pi']) {
    const result = f.run(host, 'configure');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not include native adapters/);
    assert.equal(existsSync(f.settings(host)), false);
  }
});

test('Cursor native package uses Cursor root variables and valid nonblocking hook responses', (t) => {
  const f = fixture(t);
  const pkg = join(repo, 'plugins/cursor/greatping');
  const cursorRoot = `\${CURSOR_PLUGIN_ROOT}`;
  const metadata = JSON.parse(readFileSync(join(pkg, '.cursor-plugin/plugin.json')));
  assert.equal(metadata.name, 'greatping');
  const hooks = JSON.parse(readFileSync(join(pkg, 'hooks/hooks.json')));
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks), [
    'sessionStart',
    'beforeSubmitPrompt',
    'stop',
    'sessionEnd',
  ]);
  assert.equal(hooks.hooks.stop[0].async, undefined);
  assert.ok(hooks.hooks.stop[0].command.includes(cursorRoot));
  const mcp = JSON.parse(readFileSync(join(pkg, 'mcp.json'))).mcpServers.greatping;
  assert.deepEqual(mcp.args, [`${cursorRoot}/scripts/bridge.mjs`, 'cursor', 'mcp']);
  assert.equal(
    readFileSync(join(pkg, 'skills/greatping/SKILL.md'), 'utf8'),
    readFileSync(join(repo, 'skills/greatping/SKILL.md'), 'utf8'),
  );
  // An unconfigured or opted-out notification hook must still return valid
  // allow JSON to Cursor. It must never block a prompt or inject a follow-up.
  for (const overrides of [{}, { GREATPING_DISABLE: '1' }]) {
    const result = f.run('cursor', 'hook', [], overrides);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    assert.equal(result.stderr, '');
  }
});

test('plugin launcher check exposes a mismatched pairing without changing preferences', (t) => {
  const f = fixture(t);
  assert.equal(f.run('codex', 'configure').status, 0);
  const saved = readFileSync(f.settings('codex'), 'utf8');
  const result = f.run('codex', 'check', [], { FIXTURE_PAIRING_PROBLEM: 'environment_mismatch' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Saved pairing belongs to another environment/);
  assert.equal(readFileSync(f.settings('codex'), 'utf8'), saved);
});
