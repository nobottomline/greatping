import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { doctorReport } from '../src/commands/doctor.ts';
import { DEFAULT_API_URL, saveConfig } from '../src/config.ts';

/** Runs `run` with a private home and captured stdout; restores both. */
async function withPairedHome(paired, run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-report-'));
  const previous = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  const write = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  try {
    if (paired)
      saveConfig({
        machineId: 'mch_secret_id',
        machineToken: 'mc_secret-token',
        apiUrl: DEFAULT_API_URL,
      });
    const code = await run();
    return { code, stdout };
  } finally {
    process.stdout.write = write;
    process.env.HOME = previous.HOME;
    if (previous.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.XDG;
    rmSync(root, { recursive: true, force: true });
  }
}

const report = {
  schemaVersion: 1,
  scope: 'computer',
  generatedAt: Date.parse('2026-10-16T15:04:00Z'),
  plan: { tier: 'free', computerLimit: 1, customTimings: false, historyDays: 7 },
  devices: [],
  computers: [
    {
      ref: 'C1',
      self: true,
      platform: 'darwin',
      osVersion: '15.1',
      arch: 'arm64',
      cliVersion: '0.5.2',
      hosts: [],
      lastSeenAt: null,
      lastAlertAt: null,
      paused: false,
      timings: {
        stored: { escalationWaitSec: 90, reminderAfterSec: 300, presenceDelaySec: 30 },
        effective: { escalationWaitSec: 90, reminderAfterSec: 300, presenceDelaySec: 30 },
      },
      projectLabels: 'hidden',
      routes: { D1: 'first' },
    },
  ],
  requests: [],
  pushTests: [],
  truncated: false,
};

test('doctor --report prints the computer’s report on stdout without credentials or paths', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json(report);
  };
  try {
    const { code, stdout } = await withPairedHome(true, () => doctorReport());
    assert.equal(code, 0);
    assert.deepEqual(calls, [`${DEFAULT_API_URL}/v1/machine/me/diagnostics`]);
    assert.match(stdout, /^GreatPing support report\n/);
    assert.match(stdout, /GreatPing CLI \S+ · Node /);
    assert.match(stdout, /Service: GreatPing/);
    assert.match(stdout, /C1 \(this computer\) · darwin 15\.1 arm64 · CLI 0\.5\.2/);
    assert.match(stdout, /routes: D1 first/);
    for (const secret of ['mch_secret_id', 'mc_secret-token', process.env.HOME ?? '/nonexistent'])
      assert.equal(stdout.includes(secret), false, secret);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('doctor --report still prints this computer’s part when the service is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    const { code, stdout } = await withPairedHome(true, () => doctorReport());
    assert.equal(code, 1);
    assert.match(stdout, /This app or CLI\n {2}GreatPing CLI/);
    assert.match(stdout, /The service could not be reached\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('doctor --report refuses an unpaired computer and prints nothing on stdout', async () => {
  const { code, stdout } = await withPairedHome(false, () => doctorReport());
  assert.equal(code, 1);
  assert.equal(stdout, '');
});
