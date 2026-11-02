import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  configPath,
  DEFAULT_API_URL,
  loadConfig,
  removeConfig,
  saveConfig,
} from '../src/config.ts';
import { askQuestion, sendNotice } from '../src/operations.ts';
import { reconcileQuestionCancellations, withdrawQuestion } from '../src/question-cancellation.ts';
import { pairedConfig } from './fixtures/account.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const intent = () => ({ requestId: 'req_cancelled', expiresAt: Date.now() + 60000 });
const request = (value) => ({ id: value.requestId, expiresAt: value.expiresAt });
async function home(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping cancellation recovery '));
  const before = process.env.XDG_CONFIG_HOME;
  const originalFetch = globalThis.fetch;
  const originalRename = fs.renameSync;
  process.env.XDG_CONFIG_HOME = root;
  const config = pairedConfig(DEFAULT_API_URL);
  saveConfig(config);
  try {
    await run({ root, config });
  } finally {
    globalThis.fetch = originalFetch;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
    rmSync(root, { recursive: true, force: true });
  }
}

test('failed withdrawal is durably recorded before HTTP and a later mutation reconciles exactly that ID', async () =>
  home(async ({ config }) => {
    const pending = intent();
    let attempts = 0;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith('/cancel')) {
        assert.deepEqual(loadConfig().pendingQuestionCancellations, [pending]);
        if (++attempts === 1)
          return Response.json({ error: { code: 'temporary' } }, { status: 503 });
        return Response.json({ id: pending.requestId, status: 'cancelled' });
      }
      if (path === '/v1/manifests') return Response.json({ manifests: [] });
      if (path === '/v1/requests' && init.method === 'POST')
        return Response.json({ id: 'req_notice', status: 'pending' });
      throw Error(`Unexpected fixture route ${path}`);
    };
    await assert.rejects(
      withdrawQuestion(config, request(pending)),
      /withdrawal could not be confirmed/,
    );
    assert.deepEqual(loadConfig().pendingQuestionCancellations, [pending]);
    assert.deepEqual(await sendNotice('Synthetic recovery notice'), {
      requestId: 'req_notice',
      status: 'accepted',
    });
    assert.equal(loadConfig().pendingQuestionCancellations, undefined);
    assert.deepEqual(calls.slice(0, 2), [
      '/v1/requests/req_cancelled/cancel',
      '/v1/requests/req_cancelled/cancel',
    ]);
  }));

test('local persistence failure still attempts HTTP withdrawal and remains visible', async () =>
  home(async ({ config }) => {
    const originalRename = fs.renameSync;
    let attempted = false;
    fs.renameSync = (from, to) => {
      if (to === configPath()) throw Error('Synthetic config write failure');
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => {
      attempted = true;
      return new Response(null, { status: 204 });
    };
    await assert.rejects(
      withdrawQuestion(config, request(intent())),
      /withdrawal was accepted, but local cancellation recovery/,
    );
    assert.equal(attempted, true);
  }));

test('a failed local acknowledgement keeps recovery even after the server accepted withdrawal', async () =>
  home(async ({ config }) => {
    const pending = intent();
    const originalRename = fs.renameSync;
    globalThis.fetch = async () => {
      fs.renameSync = (from, to) => {
        if (to === configPath()) throw Error('Synthetic cleanup write failure');
        return originalRename(from, to);
      };
      syncBuiltinESMExports();
      return Response.json({ id: pending.requestId, status: 'cancelled' });
    };
    await assert.rejects(
      withdrawQuestion(config, request(pending)),
      /local cancellation recovery could not be saved/,
    );
    assert.deepEqual(loadConfig().pendingQuestionCancellations, [pending]);
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    globalThis.fetch = async () => Response.json({ id: pending.requestId, status: 'cancelled' });
    await reconcileQuestionCancellations(config);
    assert.equal(loadConfig().pendingQuestionCancellations, undefined);
  }));

for (const lifecycle of ['logout', 'uninstall', 're-pair'])
  test(`withdrawal completion cannot restore or overwrite configuration after ${lifecycle}`, async () =>
    home(async ({ config }) => {
      const pending = intent();
      let resolve;
      globalThis.fetch = async () =>
        new Promise((done) => {
          resolve = done;
        });
      const withdrawal = withdrawQuestion(config, request(pending));
      const rejected = assert.rejects(withdrawal, /local cancellation recovery/);
      assert.deepEqual(loadConfig().pendingQuestionCancellations, [pending]);
      if (lifecycle === 'logout') saveConfig({ apiUrl: DEFAULT_API_URL });
      if (lifecycle === 'uninstall') removeConfig(config);
      const replacement = {
        ...config,
        machineToken: 'replacement-token',
        pendingQuestionCancellations: [
          { requestId: 'req_new_pairing', expiresAt: pending.expiresAt },
        ],
      };
      if (lifecycle === 're-pair') saveConfig(replacement);
      resolve(Response.json({ id: pending.requestId, status: 'cancelled' }));
      await rejected;
      if (lifecycle === 're-pair') {
        assert.equal(loadConfig().machineToken, replacement.machineToken);
        assert.deepEqual(
          loadConfig().pendingQuestionCancellations,
          replacement.pendingQuestionCancellations,
        );
      } else {
        assert.equal(loadConfig().machineToken, undefined);
        assert.equal(loadConfig().pendingQuestionCancellations, undefined);
      }
      if (lifecycle === 'uninstall') assert.equal(existsSync(configPath()), false);
    }));

test('recovery never uses a replacement pairing to cancel an older question', async () =>
  home(async ({ config }) => {
    saveConfig({
      ...config,
      machineToken: 'replacement-token',
      pendingQuestionCancellations: [intent()],
    });
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw Error('Unexpected request');
    };
    await assert.rejects(reconcileQuestionCancellations(config), /Local pairing changed/);
    assert.equal(requests, 0);
  }));

test('expired and authoritatively absent requests leave the queue; provider failures retain it and rotate', async () =>
  home(async ({ config }) => {
    const first = intent(),
      second = { ...intent(), requestId: 'req_other' };
    saveConfig({
      ...config,
      pendingQuestionCancellations: [
        { requestId: 'req_expired', expiresAt: Date.now() - 1 },
        first,
        second,
      ],
    });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(new URL(url).pathname);
      return calls.length === 1
        ? Response.json({ error: { code: 'temporary' } }, { status: 503 })
        : Response.json({ error: { code: 'not_found' } }, { status: 404 });
    };
    await reconcileQuestionCancellations(config);
    assert.deepEqual(loadConfig().pendingQuestionCancellations, [second, first]);
    await reconcileQuestionCancellations(config);
    assert.deepEqual(loadConfig().pendingQuestionCancellations, [first]);
    assert.deepEqual(calls, ['/v1/requests/req_cancelled/cancel', '/v1/requests/req_other/cancel']);
  }));

test('recovery retry has a bounded network budget and preserves a timed-out intent', async () =>
  home(async ({ config }) => {
    const pending = intent();
    saveConfig({ ...config, pendingQuestionCancellations: [pending] });
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    const started = Date.now();
    await reconcileQuestionCancellations(config);
    assert.ok(Date.now() - started < 2500);
    assert.deepEqual(loadConfig().pendingQuestionCancellations, [pending]);
  }));

test('a concurrent live ask is not withdrawn by another mutating operation', async () =>
  home(async () => {
    const controller = new AbortController();
    let created;
    const began = new Promise((resolve) => {
      created = resolve;
    });
    const cancellations = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/manifests') return Response.json({ manifests: [] });
      if (path === '/v1/requests' && init.method === 'POST') {
        const kind = JSON.parse(init.body).kind;
        return Response.json({
          id: kind === 'ask' ? 'req_live' : 'req_notice',
          status: 'pending',
          expiresAt: Date.now() + 60000,
        });
      }
      if (path === '/v1/requests/req_live' && init.method === 'GET')
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      if (path.endsWith('/cancel')) {
        cancellations.push(path);
        return Response.json({ id: 'req_live', status: 'cancelled' });
      }
      throw Error(`Unexpected fixture route ${path}`);
    };
    const live = askQuestion('Synthetic live question', [], 10, {
      signal: controller.signal,
      onCreated: created,
    });
    await began;
    await sendNotice('Synthetic concurrent notice');
    assert.deepEqual(cancellations, []);
    assert.equal(loadConfig().pendingQuestionCancellations, undefined);
    controller.abort();
    assert.equal((await live).status, 'cancelled');
    assert.deepEqual(cancellations, ['/v1/requests/req_live/cancel']);
  }));

const cli = process.env.GREATPING_TEST_CLI ?? new URL('../dist/index.js', import.meta.url).pathname;
test('a failed cancelled CLI process is recovered by the next fresh CLI process before its mutation', async () =>
  home(async ({ root }) => {
    const log = join(root, 'calls.jsonl');
    const mode = join(root, 'mode');
    writeFileSync(mode, 'fail');
    const preload = join(root, 'fetch.mjs');
    writeFileSync(
      preload,
      `import {appendFileSync,readFileSync} from 'node:fs';
const log=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
globalThis.fetch=async(url,init)=>{
 const path=new URL(url).pathname;
 if(path==='/v1/manifests')return Response.json({manifests:[]});
 if(path==='/v1/requests'&&init.method==='POST'){
  const kind=JSON.parse(init.body).kind;log({event:'create',kind});
  if(kind==='ask')await new Promise(r=>setTimeout(r,250));
  return Response.json({id:kind==='ask'?'req_subprocess':'req_notice',status:'pending',expiresAt:Date.now()+60000});
 }
 if(path==='/v1/requests/req_subprocess/cancel'){
  const config=JSON.parse(readFileSync(${JSON.stringify(configPath())},'utf8'));
  log({event:'cancel',persisted:config.pendingQuestionCancellations?.some(v=>v.requestId==='req_subprocess')===true});
  if(readFileSync(${JSON.stringify(mode)},'utf8')==='fail')return Response.json({error:{code:'offline'}},{status:503});
  return Response.json({id:'req_subprocess',status:'cancelled'});
 }
 throw Error('Unexpected offline fixture route');
};`,
    );
    const env = { ...process.env, NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1' };
    const child = spawn(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        'ask',
        'Synthetic subprocess question',
        '--json',
        '--timeout',
        '10s',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    const records = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [];
    try {
      for (let i = 0; i < 300 && !records().length; i++) await delay(10);
      assert.equal(records()[0]?.kind, 'ask');
      child.kill('SIGTERM');
      assert.equal(await Promise.race([closed, delay(5000).then(() => 'hung')]), 1, stderr);
      assert.equal(
        loadConfig().pendingQuestionCancellations?.[0]?.requestId,
        'req_subprocess',
        'failed cancellation must survive this CLI process',
      );
      assert.match(stderr, /withdrawal could not be confirmed/);
      assert.equal(records()[1]?.persisted, true);
      writeFileSync(mode, 'success');
      const next = spawnSync(
        process.execPath,
        ['--import', preload, cli, 'notify', 'Synthetic next mutation', '--json'],
        { env, encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(next.status, 0, next.stderr);
      assert.equal(loadConfig().pendingQuestionCancellations, undefined);
      assert.deepEqual(
        records().map(({ event, kind }) => [event, kind]),
        [
          ['create', 'ask'],
          ['cancel', undefined],
          ['cancel', undefined],
          ['create', 'notify'],
        ],
      );
    } finally {
      child.kill('SIGKILL');
    }
  }));
