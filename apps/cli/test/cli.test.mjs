import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { api } from '../src/api.ts';
import {
  configPath,
  DEFAULT_API_URL,
  loadConfig,
  requireServer,
  saveConfig,
} from '../src/config.ts';
import { ago, parseDuration } from '../src/duration.ts';
import { renderQr } from '../src/qr.ts';
import { MIN_NODE_VERSION, supportsNodeVersion } from '../src/version.ts';

test('the runtime contract rejects old Node and accepts supported LTS versions', () => {
  assert.equal(MIN_NODE_VERSION, '22.20.0');
  for (const version of ['20.20.0', '22.19.9', '22', '', 'not-a-version']) {
    assert.equal(supportsNodeVersion(version), false, version);
  }
  for (const version of ['22.20.0', '22.20.1', '22.21.0', '24.11.0', '24.21.0']) {
    assert.equal(supportsNodeVersion(version), true, version);
  }
});

function withHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-cli-'));
  const previous = {
    HOME: process.env.HOME,
    XDG: process.env.XDG_CONFIG_HOME,
    API: process.env.GREATPING_API_URL,
  };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  delete process.env.GREATPING_API_URL;
  try {
    run(root);
  } finally {
    for (const [key, value] of [
      ['HOME', previous.HOME],
      ['XDG_CONFIG_HOME', previous.XDG],
      ['GREATPING_API_URL', previous.API],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('the service is built in; old overrides and unpaired config cannot select a host', () => {
  withHome(() => {
    assert.equal(DEFAULT_API_URL, 'https://greatping-api-dev.ueldo343.workers.dev');
    assert.equal(loadConfig().apiUrl, DEFAULT_API_URL);
    saveConfig({ apiUrl: 'https://other.example/' });
    process.env.GREATPING_API_URL = 'https://override.example';
    assert.equal(loadConfig().apiUrl, DEFAULT_API_URL);
    requireServer(loadConfig());
  });
});

test('existing pairings keep their issuer; unrelated or missing origins cannot redirect credentials', () => {
  withHome(() => {
    const credential = { machineId: 'mac_1', machineToken: 'test-token' };
    saveConfig({ ...credential, apiUrl: `${DEFAULT_API_URL}/` });
    assert.deepEqual(loadConfig(), { ...credential, apiUrl: DEFAULT_API_URL });
    requireServer(loadConfig());
    for (const apiUrl of ['https://other.example', '', undefined]) {
      saveConfig({ ...credential, apiUrl });
      assert.equal(loadConfig().machineToken, credential.machineToken);
      assert.throws(() => requireServer(loadConfig()), /different or unknown/);
    }
    saveConfig({ apiUrl: DEFAULT_API_URL });
    assert.equal(loadConfig().machineToken, undefined);
    for (const value of ['null', '[]', '42', '{bad']) {
      writeFileSync(configPath(), value);
      assert.equal(loadConfig().apiUrl, DEFAULT_API_URL);
      assert.equal(loadConfig().machineToken, undefined);
    }
  });
});

test('durations accept seconds, minutes and hours', () => {
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('1H'), 3600);
  assert.equal(parseDuration('2d'), 172800);
  assert.equal(ago(Date.now() - 5 * 60_000), '5m ago');
  assert.equal(parseDuration('5y'), null);
  assert.equal(parseDuration(''), null);
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

test('QR renders square with a quiet zone, colored and plain', () => {
  const colored = renderQr('greatping://pair?code=ABCD-EFGH', true);
  const side = colored.length;
  assert.ok(side >= 25);
  // Two background-colored spaces per module; every line resets its color.
  for (const line of colored) {
    assert.equal(line.replace(ANSI, '').length, side * 2);
    assert.ok(line.endsWith(`${ESC}[0m`));
  }
  // Quiet zone: first and last rows are fully light.
  assert.ok(!colored[0].includes(`${ESC}[40m`));
  const plain = renderQr('greatping://pair?code=ABCD-EFGH', false);
  assert.equal(plain.length, Math.ceil(side / 2));
  assert.ok(!plain.join('').includes(ESC));
});

test('describes the computer without secrets', async () => {
  const { describeMachine } = await import('../src/describe.ts');
  const hosts = [
    { id: 'claude-code', hooks: 'ok', finished: false, mcp: false, skill: true, lastHookAt: null },
    { id: 'codex', hooks: 'off', finished: false, mcp: true, skill: false, lastHookAt: null },
  ];
  const description = describeMachine({ cliVersion: '1.2.3', hosts });
  assert.deepEqual(description.integrations, ['claude-code', 'codex']);
  assert.deepEqual(description.hosts, hosts);
  assert.equal(typeof description.arch, 'string');
  assert.equal(description.cliVersion, '1.2.3');
  assert.deepEqual(
    Object.keys(description).filter(
      (key) => !['osVersion', 'arch', 'cliVersion', 'integrations', 'hosts'].includes(key),
    ),
    [],
  );
});

test('non-service destinations are refused before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Unexpected network call');
  };
  try {
    for (const apiUrl of [
      '',
      'not-a-url',
      'file:///tmp/server',
      'https://other.example',
      `${DEFAULT_API_URL}/other`,
      `${DEFAULT_API_URL}@other.example`,
    ]) {
      await assert.rejects(
        api({ apiUrl, machineId: 'test', machineToken: 'test' }, 'POST', '/pair/start'),
      );
    }
    assert.equal(requests, 0);
    requireServer({ apiUrl: DEFAULT_API_URL });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API requests use the service credential and refuse redirects', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await api({ apiUrl: DEFAULT_API_URL, machineToken: 'test-token' }, 'GET', '/machine/me');
    assert.equal(calls[0].url, `${DEFAULT_API_URL}/v1/machine/me`);
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
    assert.equal(calls[0].options.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a real redirect response cannot forward a credential or trigger a second request', async () => {
  const calls = [];
  const relay = createServer((request, response) => {
    calls.push(request.url);
    response.writeHead(302, { location: '/credential-target' });
    response.end();
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    originalFetch(
      url.replace(DEFAULT_API_URL, `http://127.0.0.1:${relay.address().port}`),
      options,
    );
  try {
    await assert.rejects(
      api({ apiUrl: DEFAULT_API_URL, machineToken: 'test-token' }, 'GET', '/machine/me'),
      (error) => error.code === 'network',
    );
    assert.deepEqual(calls, ['/v1/machine/me']);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => relay.close(resolve));
  }
});

test('MCP client names map to alert hosts', async () => {
  const { hostFromClientName } = await import('../src/operations.ts');
  for (const [name, host] of [
    ['claude-code', 'claude-code'],
    ['codex-mcp-client', 'codex'],
    ['cursor-vscode', 'cursor'],
    ['opencode', 'opencode'],
    ['gemini-cli-mcp-client', 'gemini-cli'],
    ['pi', 'pi'],
    ['pi-coding-agent', 'pi'],
    ['pipeline-runner', 'other'],
    [undefined, 'other'],
  ]) {
    assert.equal(hostFromClientName(name), host, String(name));
  }
});

test('greatping project names, hides and resets the current project locally', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const cli = new URL('../dist/index.js', import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), 'greatping-project-'));
  try {
    const repo = join(root, 'acme-acquisition-2026');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'web'));
    const run = (...args) =>
      spawnSync(process.execPath, [cli, 'project', ...args], {
        cwd: join(repo, 'web'),
        env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, '.config') },
        encoding: 'utf8',
      });
    assert.equal(run('name', 'Client', 'A').status, 0);
    const named = JSON.parse(run('show', '--json').stdout);
    assert.equal(named.root.endsWith('acme-acquisition-2026'), true);
    assert.deepEqual(named.override, { name: 'Client A' });
    assert.equal(named.mode, 'hidden');
    assert.equal(run('hide').status, 0);
    assert.deepEqual(JSON.parse(run('list', '--json').stdout).projects[named.root], {
      hidden: true,
    });
    assert.equal(run('reset').status, 0);
    assert.deepEqual(JSON.parse(run('list', '--json').stdout).projects, {});
    // Changing the computer's mode needs a pairing.
    assert.notEqual(run('labels', 'folder').status, 0);
    assert.notEqual(run('labels', 'sometimes').status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
