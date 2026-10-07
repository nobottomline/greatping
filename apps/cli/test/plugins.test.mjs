import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { HOSTS, installHooks } from '../src/integrations/host-hooks.ts';
import { hostIntegrations, inspectHost, pluginDiagnostics } from '../src/integrations/index.ts';
import { inspectPlugin } from '../src/integrations/plugins.ts';
import { getAgentStatus } from '../src/operations.ts';

const repo = new URL('../../../', import.meta.url).pathname;
const pluginVersion = JSON.parse(
  readFileSync(join(repo, 'plugins/codex/greatping/plugin.json'), 'utf8'),
).version;
const cli = process.env.GREATPING_TEST_CLI ?? new URL('../dist/index.js', import.meta.url).pathname;
const node = process.env.GREATPING_TEST_NODE ?? process.execPath;
const json = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

async function fixture(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping plugin onboarding '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PATH: join(root, 'bin'),
    NO_COLOR: '1',
    CI: '1',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  for (const path of Object.values(env).slice(0, 7)) mkdirSync(path, { recursive: true });
  symlinkSync(node, join(env.PATH, process.platform === 'win32' ? 'node.exe' : 'node'));
  const pairing = join(env.XDG_CONFIG_HOME, 'greatping/config.json');
  json(pairing, { fixture: 'preserved' });
  const invoke = (args) =>
    spawnSync(node, [cli, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
  const plugin = (host, enabled = true, version = pluginVersion) => {
    const path = join(
      host === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME,
      'plugins/cache/greatping/greatping',
      version,
    );
    cpSync(join(repo, 'plugins', host, 'greatping'), path, { recursive: true });
    if (host === 'claude') {
      json(join(env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'), {
        version: 2,
        plugins: { 'greatping@greatping': [{ scope: 'user', installPath: path, version }] },
      });
      json(HOSTS.claude.settingsPath(), {
        enabledPlugins: { 'greatping@greatping': enabled },
        foreign: 'preserved',
      });
    } else {
      writeFileSync(
        join(env.CODEX_HOME, 'config.toml'),
        `[plugins.'greatping@greatping']\nenabled = ${enabled}\n`,
      );
    }
    return path;
  };
  try {
    await run({ root, env, invoke, plugin, pairing });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a leftover cache or unrelated plugin is not a registered GreatPing installation', async (t) =>
  fixture(t, async ({ env }) => {
    cpSync(
      join(repo, 'plugins/codex/greatping'),
      join(env.CODEX_HOME, 'plugins/cache/greatping/greatping/old'),
      { recursive: true },
    );
    writeFileSync(
      join(env.CODEX_HOME, 'config.toml'),
      '[plugins."foreign@market"]\nenabled = true\n',
    );
    assert.equal(inspectPlugin('codex').status, 'absent');
    assert.equal(inspectPlugin('claude').status, 'absent');
  }));

test('setup discovers both packages, keeps private pairing and avoids duplicate integrations', async (t) =>
  fixture(t, async ({ env, invoke, plugin, pairing }) => {
    const before = readFileSync(pairing, 'utf8');
    const settings = {};
    for (const host of ['claude', 'codex']) {
      plugin(host);
      const path =
        host === 'claude' ? HOSTS.claude.settingsPath() : join(env.CODEX_HOME, 'config.toml');
      settings[host] = readFileSync(path, 'utf8');
      assert.equal(inspectPlugin(host).status, 'unconfigured');
      const unapproved = invoke(['setup', host]);
      assert.equal(unapproved.status, 1);
      assert.match(unapproved.stderr, /--yes/);
      const result = invoke(['setup', host, '--yes']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /plugin configured/);
      assert.equal(inspectPlugin(host).status, 'ready');
      assert.equal(inspectHost(host).hooks.status, 'off');
      assert.equal(readFileSync(path, 'utf8'), settings[host]);
      assert.equal(existsSync(join(env.XDG_CONFIG_HOME, 'greatping/setup-options.json')), false);
    }
    const integrations = hostIntegrations();
    assert.deepEqual(
      integrations.map((entry) => [entry.id, entry.hooks, entry.mcp, entry.skill, entry.finished]),
      [
        ['claude-code', 'ok', true, true, false],
        ['codex', 'ok', true, true, true],
      ],
    );
    const status = JSON.parse(invoke(['status', '--json']).stdout);
    assert.deepEqual(status.integrations, integrations);
    assert.equal(status.plugins.find((entry) => entry.id === 'codex').hookTrust, 'host-managed');
    const mcpStatus = await getAgentStatus();
    assert.deepEqual(mcpStatus.integrations, integrations);
    assert.doesNotMatch(JSON.stringify(mcpStatus), /cache\/|launcher|config\.json/);
    assert.equal(readFileSync(pairing, 'utf8'), before);
  }));

test('disabled plugins and unreadable registrations block direct setup and hook installation', async (t) =>
  fixture(t, async ({ env, invoke, plugin, pairing }) => {
    const before = readFileSync(pairing, 'utf8');
    for (const host of ['claude', 'codex']) {
      plugin(host, false);
      assert.equal(inspectPlugin(host).status, 'disabled');
      assert.equal(invoke(['setup', host, '--yes']).status, 1);
      assert.equal(invoke(['hooks', 'install', host]).status, 1);
      assert.equal(invoke(['doctor', '--fix']).status, 1); // unpaired
      assert.equal(inspectHost(host).hooks.status, 'off');
      assert.equal(
        existsSync(join(env.XDG_CONFIG_HOME, 'greatping/plugins', `${host}.json`)),
        false,
      );
    }
    writeFileSync(join(env.CODEX_HOME, 'config.toml'), 'private = "DO_NOT_EXPOSE\n');
    assert.equal(inspectPlugin('codex').status, 'unknown');
    const result = invoke(['setup', 'codex', '--yes']);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /DO_NOT_EXPOSE/);
    assert.doesNotMatch(JSON.stringify(pluginDiagnostics()), /DO_NOT_EXPOSE/);
    assert.equal(readFileSync(pairing, 'utf8'), before);
  }));

test('doctor repairs plugin launchers and malformed preferences without restoring direct hooks', async (t) =>
  fixture(t, async ({ env, invoke, plugin }) => {
    plugin('claude');
    assert.equal(invoke(['setup', 'claude', '--yes', '--finished']).status, 0);
    const file = join(env.XDG_CONFIG_HOME, 'greatping/plugins/claude.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.launcher.command = join(env.HOME, 'missing-node');
    json(file, saved);
    assert.equal(inspectPlugin('claude').status, 'broken');
    const repaired = invoke(['doctor', '--fix']);
    assert.equal(repaired.status, 1); // pairing remains required
    assert.match(repaired.stderr, /native plugin/);
    assert.equal(inspectPlugin('claude').status, 'ready');
    assert.equal(inspectPlugin('claude').finished, true);
    assert.equal(inspectHost('claude').hooks.status, 'off');
    writeFileSync(file, '{"private":"DO_NOT_EXPOSE');
    assert.equal(invoke(['setup', 'claude', '--yes']).status, 0);
    assert.equal(inspectPlugin('claude').status, 'ready');
  }));

test('explicit migration captures alert preferences, preserves foreign hooks and retains plugin registration', async (t) =>
  fixture(t, async ({ env, invoke, plugin, pairing }) => {
    plugin('claude');
    const launcher = { command: join(env.PATH, 'node'), args: [cli] };
    installHooks(HOSTS.claude, launcher, true, ['questions']);
    const file = HOSTS.claude.settingsPath();
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'foreign-hook' }] });
    json(file, settings);
    const before = readFileSync(pairing, 'utf8');
    const conflict = invoke(['setup', 'claude', '--yes']);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /--migrate/);
    assert.notEqual(inspectHost('claude').hooks.status, 'off');
    const result = invoke(['setup', 'claude', '--migrate', '--yes']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(inspectHost('claude').hooks.status, 'off');
    assert.equal(inspectPlugin('claude').finished, true);
    assert.deepEqual(inspectPlugin('claude').alerts, ['questions']);
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(kept.enabledPlugins['greatping@greatping'], true);
    assert.equal(kept.foreign, 'preserved');
    assert.equal(kept.hooks.UserPromptSubmit[0].hooks[0].command, 'foreign-hook');
    assert.equal(readFileSync(pairing, 'utf8'), before);
  }));

test('Codex completion preference changes keep MCP and skill and always state trust limits', async (t) =>
  fixture(t, async ({ invoke, plugin }) => {
    plugin('codex');
    assert.equal(invoke(['setup', 'codex', '--yes', '--no-finished']).status, 0);
    const report = hostIntegrations().find((entry) => entry.id === 'codex');
    assert.equal(report.hooks, 'off');
    assert.equal(report.mcp, true);
    assert.equal(report.skill, true);
    const result = invoke(['doctor']);
    assert.match(result.stderr, /\/hooks/);
    assert.match(result.stderr, /questions and permissions unsupported/);
    assert.equal(invoke(['setup', 'codex', '--yes']).status, 0);
    assert.equal(inspectPlugin('codex').finished, false);
  }));

test('multiple Codex cache versions are resolved by native inventory, never by newest directory', async (t) =>
  fixture(t, async ({ env, plugin }) => {
    const selected = plugin('codex');
    cpSync(selected, join(dirname(selected), '99.0.0'), { recursive: true });
    const script = join(env.PATH, 'codex');
    writeFileSync(
      script,
      `#!${node}\nconsole.log(JSON.stringify({installed:[{pluginId:'greatping@greatping',version:'${pluginVersion}',enabled:true}]}));\n`,
      { mode: 0o755 },
    );
    assert.equal(inspectPlugin('codex').status, 'broken');
    const found = inspectPlugin('codex', true);
    assert.equal(found.status, 'unconfigured');
    assert.equal(found.path, selected);
  }));

test('incomplete installed packages cannot be configured or mistaken for working tools', async (t) =>
  fixture(t, async ({ env, invoke, plugin }) => {
    const path = plugin('claude');
    rmSync(join(path, '.mcp.json'));
    assert.equal(inspectPlugin('claude').status, 'broken');
    const result = invoke(['setup', 'claude', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /incomplete/);
    assert.equal(existsSync(join(env.XDG_CONFIG_HOME, 'greatping/plugins/claude.json')), false);
    assert.equal(hostIntegrations()[0].mcp, false);
  }));

test('hook installation preflights every host before writing any direct integration', async (t) =>
  fixture(t, async ({ env, invoke, plugin }) => {
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    plugin('codex');
    assert.equal(invoke(['hooks', 'install']).status, 1);
    assert.equal(inspectHost('claude').hooks.status, 'off');
    assert.equal(inspectHost('codex').hooks.status, 'off');
  }));

test('quoted Codex MCP registrations produce a migration conflict and are not repaired over the plugin', async (t) =>
  fixture(t, async ({ env, invoke, plugin }) => {
    plugin('codex');
    const file = join(env.CODEX_HOME, 'config.toml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        `\n[mcp_servers.'greatping'] # native TOML syntax\ncommand = 'foreign-launcher'\nargs = ['mcp']\n`,
    );
    const before = readFileSync(file, 'utf8');
    const result = invoke(['setup', 'codex', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--migrate/);
    assert.ok(inspectHost('codex').conflicts.some((value) => value.includes('MCP')));
    assert.equal(invoke(['doctor', '--fix']).status, 1);
    assert.equal(readFileSync(file, 'utf8'), before);
  }));

test('direct removal preserves native plugin registration and completion preferences', async (t) =>
  fixture(t, async ({ env, invoke, plugin }) => {
    plugin('claude');
    assert.equal(invoke(['setup', 'claude', '--yes', '--finished']).status, 0);
    const before = readFileSync(HOSTS.claude.settingsPath(), 'utf8');
    assert.equal(invoke(['setup', 'claude', '--remove', '--yes']).status, 0);
    assert.equal(readFileSync(HOSTS.claude.settingsPath(), 'utf8'), before);
    assert.equal(inspectPlugin('claude').status, 'ready');
    assert.equal(inspectPlugin('claude').finished, true);
    assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json')), true);
  }));
