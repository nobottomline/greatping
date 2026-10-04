import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addMember,
  createGenesis,
  generateKeys,
  initiatorConfirmed,
  manifestHash,
  respondToCeremony,
} from '@greatping/protocol/crypto';
import { login } from '../src/commands/login.ts';
import { DEFAULT_API_URL, loadConfig } from '../src/config.ts';

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * A fake service with a phone that approves the code it is given: the phone
 * side runs the real ceremony (sign the version adding the computer, answer
 * with the secret half), so the CLI's verification is exercised for real.
 */
async function run({ typedSecret } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-login-'));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let printed = '';
  process.stderr.write = (chunk, ...rest) => {
    printed += String(chunk);
    const done = rest.at(-1);
    if (typeof done === 'function') done();
    return true;
  };
  const calls = [];
  const phone = generateKeys(random);
  const genesis = createGenesis({
    account: 'acc_1',
    device: 'dev_phone',
    keys: phone.public,
    secret: phone.secret,
    createdAt: Date.now(),
  });
  let start;
  let expectedTag;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(`${DEFAULT_API_URL}/v1`, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/pair/start') {
      start = body;
      return json(
        {
          pairingId: 'pr_1',
          pollSecret: 'ps_secret',
          lookup: 'K7QM',
          machineId: 'mch_1',
          expiresAt: Date.now() + 60_000,
          pollIntervalSec: 0,
        },
        201,
      );
    }
    if (path === '/pair/pr_1') {
      const code = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/);
      assert.ok(code, 'the CLI shows the full code');
      const next = addMember(
        genesis,
        { id: 'dev_phone', secret: phone.secret },
        { kind: 'computer', id: 'mch_1', ...start.keys },
        Date.now(),
      );
      const answer = respondToCeremony({
        kind: 'pair',
        sessionId: start.session,
        // A mistyped half differs from the shown one by construction.
        secret: typedSecret ? (code[1] === 'ZZZZ' ? 'YYYY' : 'ZZZZ') : code[1],
        initiatorShare: start.share,
        initiatorKeys: start.keys,
        device: 'dev_phone',
        manifestHash: manifestHash(next),
        random,
      });
      expectedTag = answer.expectedInitiatorTag;
      return json({
        status: 'approved',
        machineId: 'mch_1',
        machineToken: 'mc_token',
        accountId: 'acc_1',
        deviceCount: 1,
        ceremony: {
          share: answer.share,
          device: 'dev_phone',
          manifestHash: manifestHash(next),
          tag: answer.tag,
        },
        manifests: [genesis, next],
      });
    }
    if (path === '/machine/me' && init.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (path === '/machine/me/ceremony') return new Response(null, { status: 204 });
    if (path.startsWith('/manifests')) return json({ manifests: [] });
    if (path === '/machine/me' && init.method === 'PATCH') return json({});
    if (path === '/machine/me')
      return json({
        accountId: 'acc_1',
        machine: { id: 'mch_1', name: 'Mac', projectLabels: 'hidden' },
        devices: [],
      });
    return json({ error: { code: 'not_found', message: path } }, 404);
  };
  try {
    const code = await login({ name: 'Test Mac' });
    return { code, calls, config: loadConfig(), start, expectedTag, printed };
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    rmSync(root, { recursive: true, force: true });
  }
}

test('login pairs only after verifying the phone’s answer and confirms back', async () => {
  const { code, calls, config, start, expectedTag, printed } = await run();
  assert.equal(code, 0);
  // The server never received the secret half the CLI showed.
  const secret = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/)?.[1];
  assert.ok(secret);
  assert.ok(start.keys && start.share && start.session);
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call), new RegExp(secret));
  assert.equal(config.machineToken, 'mc_token');
  assert.equal(config.manifest.version, 2);
  assert.ok(config.keys?.sign && config.keys?.enc);
  const confirm = calls.find((c) => c.path === '/machine/me/ceremony');
  assert.ok(confirm, 'the computer posts its tag');
  assert.equal(initiatorConfirmed(expectedTag, confirm.body.tag), true);
  // Its first report carries the verified manifest version.
  const report = calls.find((c) => c.path === '/machine/me' && c.method === 'PATCH');
  assert.equal(report?.body.manifestVersion, 2);
});

test('login refuses and revokes itself when the code did not match', async () => {
  const { code, calls, config, printed } = await run({ typedSecret: true });
  assert.equal(code, 2);
  assert.ok(calls.some((c) => c.path === '/machine/me' && c.method === 'DELETE'));
  assert.equal(config.machineToken, undefined);
  assert.match(printed, /did not match/);
});
