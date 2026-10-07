#!/usr/bin/env node
// Native host verification in disposable homes. No model runs, pairing or API writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'greatping native plugins '));
const home = join(temporary, 'home');
const market = join(temporary, 'marketplace');
const config = join(temporary, 'config');
const bin = join(temporary, 'bin');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: config,
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}: ${result.stderr || result.stdout || result.error}`,
  );
  return result.stdout;
}

async function verifyMcp(host, installed) {
  const path = join(installed, 'scripts/bridge.mjs');
  const child = spawn(process.execPath, [path, host, 'mcp'], {
    env: { ...env, PATH: bin },
    stdio: 'pipe',
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk;
  });
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    const entry = pending.get(response.id);
    if (entry) {
      pending.delete(response.id);
      clearTimeout(entry.timer);
      entry.done(response);
    }
  });
  const request = (method, params = {}) =>
    new Promise((done, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new Error(`MCP timeout: ${method}; ${diagnostic}`)),
        5000,
      );
      pending.set(id, { timer, done });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const initialize = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: host, version: 'plugin-test' },
    });
    assert.equal(initialize.error, undefined);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const inventory = await request('tools/list');
    assert.deepEqual(inventory.result.tools.map((tool) => tool.name).sort(), [
      'ask_user',
      'get_status',
      'notify',
      'pause_alerts',
      'resume_alerts',
    ]);
    const status = await request('tools/call', { name: 'get_status', arguments: {} });
    assert.equal(status.result.structuredContent.connection, 'unpaired');
    assert.equal(
      status.result.structuredContent.plugins.find((entry) => entry.id === host)?.status,
      'ready',
    );
    assert.equal(
      status.result.structuredContent.integrations.find(
        (entry) => entry.id === (host === 'claude' ? 'claude-code' : 'codex'),
      )?.mcp,
      true,
    );
  } finally {
    child.kill('SIGTERM');
    await closed;
    lines.close();
    for (const { timer } of pending.values()) clearTimeout(timer);
  }
}

try {
  for (const path of [home, bin, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, join(config, 'greatping')])
    mkdirSync(path, { recursive: true });
  const pairing = join(config, 'greatping/config.json');
  const original = '{"fixture":"preserved"}\n';
  writeFileSync(pairing, original);
  symlinkSync(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  env.PATH = [bin, process.env.PATH].join(process.platform === 'win32' ? ';' : ':');
  run(process.execPath, ['scripts/build-agent-plugins.mjs', '--output', market]);
  const claudeVersion = run('claude', ['--version']).trim();
  const codexVersion = run('codex', ['--version']).trim();
  run('claude', ['plugin', 'validate', market, '--strict']);
  run('claude', ['plugin', 'validate', join(market, 'plugins/claude/greatping'), '--strict']);
  run('claude', ['plugin', 'marketplace', 'add', market]);
  run('claude', ['plugin', 'install', 'greatping@greatping']);
  const claude = JSON.parse(run('claude', ['plugin', 'list', '--json']));
  const claudePath = claude.find((entry) => entry.id === 'greatping@greatping')?.installPath;
  assert.ok(claudePath);
  run('codex', ['plugin', 'marketplace', 'add', market, '--json']);
  const codex = JSON.parse(run('codex', ['plugin', 'add', 'greatping@greatping', '--json']));
  assert.equal(
    codex.version,
    JSON.parse(readFileSync(join(market, 'plugins/codex/greatping/plugin.json'), 'utf8')).version,
  );
  const installed = JSON.parse(run('codex', ['plugin', 'list', '--json'])).installed;
  assert.equal(installed.find((entry) => entry.pluginId === 'greatping@greatping')?.enabled, true);
  for (const [host, path] of [
    ['claude', claudePath],
    ['codex', codex.installedPath],
  ]) {
    const bridge = join(path, 'scripts/bridge.mjs');
    const configured = run(process.execPath, [
      join(root, 'apps/cli/dist/index.js'),
      'setup',
      host,
      '--yes',
    ]);
    assert.equal(configured, '');
    run(process.execPath, [bridge, host, 'check']);
    assert.equal(
      readFileSync(join(path, 'skills/greatping/SKILL.md'), 'utf8'),
      readFileSync(join(root, 'skills/greatping/SKILL.md'), 'utf8'),
    );
    run(process.execPath, [bridge, host, 'hook'], {
      env: { ...env, PATH: bin },
      input: '{"hook_event_name":"GreatPingProbe","session_id":"plugin-fixture"}\n',
    });
    await verifyMcp(host, path);
  }
  run('claude', ['plugin', 'uninstall', 'greatping@greatping']);
  run('codex', ['plugin', 'remove', 'greatping@greatping']);
  assert.equal(readFileSync(pairing, 'utf8'), original);
  console.log(
    `Verified ${claudeVersion} and ${codexVersion}: native installation, copied skills, launcher checks, hook entrypoints, five MCP tools, read-only unpaired status and removal preserving local config.`,
  );
  console.log(
    'No native prompt dispatch, hook trust, remote API, production change or phone delivery was exercised.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
