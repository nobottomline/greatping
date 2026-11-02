import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addMember, generateKeys } from '@greatping/protocol/crypto';
import {
  configDir,
  configPath,
  DEFAULT_API_URL,
  loadConfig,
  removeConfig,
  saveConfig,
  updateConfig,
} from '../src/config.ts';
import { confirmPendingCeremony, followManifest } from '../src/keys.ts';
import { manifest, pairedConfig, phone } from './fixtures/account.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function home(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping config lifecycle '));
  const before = process.env.XDG_CONFIG_HOME;
  const fetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = root;
  try {
    await run(root);
  } finally {
    globalThis.fetch = fetch;
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
    rmSync(root, { recursive: true, force: true });
  }
}
function next(current, id) {
  return addMember(
    current,
    { id: phone.id, secret: phone.secret },
    {
      id,
      kind: 'device',
      ...generateKeys((n) => crypto.getRandomValues(new Uint8Array(n))).public,
    },
    Date.now() - 1000,
  );
}
const newer = next(manifest, 'dev_second');
const newest = next(newer, 'dev_third');

for (const lifecycle of ['logout', 'uninstall', 're-pair'])
  test(`in-flight manifest refresh cannot restore pairing after ${lifecycle}`, async () =>
    home(async () => {
      const config = pairedConfig(DEFAULT_API_URL);
      saveConfig(config);
      const response = deferred();
      globalThis.fetch = () => response.promise;
      const refresh = followManifest(config);
      const rejected = assert.rejects(refresh, /Local pairing changed/);
      if (lifecycle === 'logout') saveConfig({ apiUrl: DEFAULT_API_URL });
      if (lifecycle === 'uninstall') removeConfig(config);
      if (lifecycle === 're-pair') saveConfig({ ...config, machineToken: 'replacement-token' });
      response.resolve(Response.json({ manifests: [newer] }));
      await rejected;
      assert.equal(
        loadConfig().machineToken,
        lifecycle === 're-pair' ? 'replacement-token' : undefined,
      );
      if (lifecycle === 'uninstall') assert.equal(existsSync(configPath()), false);
    }));

test('out-of-order manifest refresh preserves newer version and concurrent ceremony changes', async () =>
  home(async () => {
    const config = pairedConfig(DEFAULT_API_URL, { pendingCeremonyTag: 'a'.repeat(86) });
    saveConfig(config);
    const responses = [deferred(), deferred()];
    let count = 0;
    globalThis.fetch = () => responses[count++].promise;
    const first = followManifest(config);
    const second = followManifest(config);
    responses[1].resolve(Response.json({ manifests: [newer, newest] }));
    assert.deepEqual(await second, { status: 'current', version: newest.version });
    updateConfig(config, (current) => {
      const { pendingCeremonyTag, ...saved } = current;
      return saved;
    });
    responses[0].resolve(Response.json({ manifests: [newer] }));
    assert.deepEqual(await first, { status: 'current', version: newest.version });
    assert.equal(loadConfig().manifest.version, newest.version);
    assert.equal(loadConfig().pendingCeremonyTag, undefined);
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  }));

test('ceremony acknowledgement retains a concurrent verified manifest update', async () =>
  home(async () => {
    const config = pairedConfig(DEFAULT_API_URL, { pendingCeremonyTag: 'a'.repeat(86) });
    saveConfig(config);
    const response = deferred();
    globalThis.fetch = () => response.promise;
    const confirm = confirmPendingCeremony(config);
    updateConfig(config, (current) => ({ ...current, manifest: newest }));
    response.resolve(new Response(null, { status: 204 }));
    await confirm;
    assert.equal(loadConfig().manifest.version, newest.version);
    assert.equal(loadConfig().pendingCeremonyTag, undefined);
  }));

function worker(code, env) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      new URL('./ts-resolve.mjs', import.meta.url).pathname,
      '--input-type=module',
      '-e',
      code,
    ],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { child, closed, output: () => stdout };
}
const moduleUrl = new URL('../src/config.ts', import.meta.url).href;

test('real competing processes serialize read-modify-write without partial files or lost updates', async () =>
  home(async (root) => {
    saveConfig(pairedConfig(DEFAULT_API_URL));
    const code = `import {loadConfig,updateConfig} from ${JSON.stringify(moduleUrl)};
const expected=loadConfig();
for(let i=0;i<25;i++) updateConfig(expected,current=>({...current,pendingCeremonyTag:String(Number(current.pendingCeremonyTag?.slice(0,5)??0)+1).padStart(5,'0')+'a'.repeat(81)}));`;
    const workers = Array.from({ length: 4 }, () => worker(code, { XDG_CONFIG_HOME: root }));
    for (const result of await Promise.all(workers.map((w) => w.closed)))
      assert.equal(result.code, 0, result.stderr);
    assert.equal(loadConfig().pendingCeremonyTag.slice(0, 5), '00100');
    assert.deepEqual(
      readdirSync(configDir()).filter((n) => n.startsWith('.config-lock')),
      [],
    );
  }));

test('a killed writer does not prevent later config updates', async () =>
  home(async (root) => {
    saveConfig(pairedConfig(DEFAULT_API_URL));
    const writer = worker(
      `import {loadConfig,updateConfig} from ${JSON.stringify(moduleUrl)};
updateConfig(loadConfig(), current=>{ console.log('LOCKED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000); return current; });`,
      { XDG_CONFIG_HOME: root },
    );
    for (let i = 0; i < 200 && !writer.output().includes('LOCKED'); i++) await delay(10);
    assert.match(writer.output(), /LOCKED/);
    writer.child.kill('SIGKILL');
    await writer.closed;
    updateConfig(loadConfig(), (current) => ({ ...current, manifest: newest }));
    assert.equal(loadConfig().manifest.version, newest.version);
    assert.deepEqual(
      readdirSync(configDir()).filter((n) => n.startsWith('.config-lock')),
      [],
    );
  }));

test('a live config writer has a bounded wait and cannot be stolen', async () =>
  home(async (root) => {
    saveConfig(pairedConfig(DEFAULT_API_URL));
    const writer = worker(
      `import {loadConfig,updateConfig} from ${JSON.stringify(moduleUrl)};
updateConfig(loadConfig(), current=>{ console.log('LOCKED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000); return current; });`,
      { XDG_CONFIG_HOME: root },
    );
    try {
      for (let i = 0; i < 200 && !writer.output().includes('LOCKED'); i++) await delay(10);
      assert.match(writer.output(), /LOCKED/);
      const started = Date.now();
      assert.throws(
        () => updateConfig(loadConfig(), (current) => ({ ...current, manifest: newest })),
        /pairing is busy/,
      );
      assert.ok(Date.now() - started < 6000);
      assert.equal(loadConfig().manifest.version, manifest.version);
    } finally {
      writer.child.kill('SIGKILL');
      await writer.closed;
    }
    updateConfig(loadConfig(), (current) => ({ ...current, manifest: newest }));
    assert.equal(loadConfig().manifest.version, newest.version);
  }));
