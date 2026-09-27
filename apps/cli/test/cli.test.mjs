import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, saveConfig } from '../src/config.ts';
import { ago, parseDuration } from '../src/duration.ts';
import { renderQr } from '../src/qr.ts';

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

test('server precedence: flag, environment, saved config, default', () => {
  withHome(() => {
    assert.match(loadConfig().apiUrl, /^https:\/\//);
    saveConfig({ apiUrl: 'https://saved.example/' });
    assert.equal(loadConfig().apiUrl, 'https://saved.example');
    process.env.GREATPING_API_URL = 'http://env.example';
    assert.equal(loadConfig().apiUrl, 'http://env.example');
    assert.equal(loadConfig('http://flag.example//').apiUrl, 'http://flag.example');
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
