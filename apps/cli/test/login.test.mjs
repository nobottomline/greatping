import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addMember,
  createGenesis,
  doneConfirmed,
  generateKeys,
  respondToCeremony,
} from '@greatping/protocol/crypto';
import { login } from '../src/commands/login.ts';
import { DEFAULT_API_URL, loadConfig, saveConfig } from '../src/config.ts';

import { reportMachine } from '../src/report.ts';

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * A fake service with a phone that runs the real pairing v2 ceremony: it
 * answers with the code it was given (M2), checks the computer's tag (M3),
 * and only then signs the version adding the computer and approves (M4).
 * `tamper` lets a test play a server that alters what it relays.
 */
async function run({
  typedSecret,
  tamper = {},
  backgroundRetry = false,
  localLogout = false,
} = {}) {
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
  let responder;
  let state = 'pending';
  let approved;
  let expectedDone;
  let signed = false;
  let doneAttempts = 0;
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
    if (path === '/pair/pr_1' && state === 'pending') {
      const code = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/);
      assert.ok(code, 'the CLI shows the full code');
      // The phone answers with the identity the preview shows.
      responder = respondToCeremony({
        kind: 'pair',
        session: start.session,
        // A mistyped half differs from the shown one by construction.
        secret: typedSecret ? (code[1] === 'ZZZZ' ? 'YYYY' : 'ZZZZ') : code[1],
        initiatorShare: start.share,
        initiator: {
          memberId: 'mch_1',
          name: start.machineName,
          platform: start.platform,
          keys: start.keys,
        },
        responder: { accountId: 'acc_1', deviceId: 'dev_phone' },
        random,
      });
      state = 'responded';
    }
    if (path === '/pair/pr_1' && state === 'responded') {
      const response = { share: responder.share, accountId: 'acc_1', deviceId: 'dev_phone' };
      return json({ status: 'responded', response, confirmed: false });
    }
    if (path === '/pair/pr_1/confirm') {
      // The phone checks the computer's tag before it signs anything.
      if (!responder.confirm(body.tag)) {
        state = 'aborted';
        return new Response(null, { status: 204 });
      }
      const next = addMember(
        genesis,
        { id: 'dev_phone', secret: phone.secret },
        { kind: 'computer', id: 'mch_1', ...start.keys },
        Date.now(),
      );
      signed = true;
      const approval = responder.approval(next);
      expectedDone = responder.expectedDone(approval.manifestHash);
      approved = { approval, manifests: [genesis, next] };
      state = 'approved';
      if (tamper.secondAnswer) state = 'second';
      return new Response(null, { status: 204 });
    }
    if (path === '/pair/pr_1' && state === 'second') {
      // A server that sends the computer another answer after the first.
      const other = generateKeys(random).public.enc.key;
      return json({
        status: 'responded',
        response: { share: other, accountId: 'acc_1', deviceId: 'dev_phone' },
        confirmed: false,
      });
    }
    if (path === '/pair/pr_1' && state === 'aborted')
      return json({ status: 'aborted', reason: 'mismatch' });
    if (path === '/pair/pr_1' && state === 'approved') {
      state = 'claimed';
      return json({
        status: 'approved',
        machineId: 'mch_1',
        machineToken: 'mc_token',
        accountId: 'acc_1',
        deviceCount: 1,
        approval: tamper.approval
          ? { ...approved.approval, ...tamper.approval }
          : approved.approval,
        manifests: tamper.manifests ? tamper.manifests(approved.manifests) : approved.manifests,
      });
    }
    if (path === '/machine/me' && init.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (path === '/machine/me/ceremony') {
      doneAttempts++;
      if (tamper.revokedDone)
        return json({ error: { code: 'unauthorized', message: 'Removed computer' } }, 401);
      if (localLogout) saveConfig({ apiUrl: DEFAULT_API_URL });
      if (tamper.failDone && doneAttempts === 1) throw new Error('synthetic connection loss');
      return new Response(null, { status: 204 });
    }
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
    const initialConfig = loadConfig();
    const firstPrinted = printed;
    const retryCode = backgroundRetry
      ? await reportMachine(loadConfig())
      : tamper.failDone
        ? await login({ name: 'Test Mac' })
        : undefined;
    return {
      initialConfig,
      firstPrinted,
      retryCode,
      code,
      calls,
      config: loadConfig(),
      start,
      expectedDone,
      signed,
      printed,
    };
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    rmSync(root, { recursive: true, force: true });
  }
}

test('login proves the code first, then accepts only a verified approval and confirms back', async () => {
  const { code, calls, config, start, expectedDone, printed } = await run();
  assert.equal(code, 0);
  // The server never received the secret half the CLI showed.
  const secret = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/)?.[1];
  assert.ok(secret);
  assert.ok(start.keys && start.share && start.session);
  assert.equal(start.ceremony, 2);
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call), new RegExp(secret));
  // M3 went out exactly once, before the approval.
  assert.equal(calls.filter((c) => c.path === '/pair/pr_1/confirm').length, 1);
  assert.equal(config.machineToken, 'mc_token');
  assert.equal(config.manifest.version, 2);
  assert.ok(config.keys?.sign && config.keys?.enc);
  const done = calls.find((c) => c.path === '/machine/me/ceremony');
  assert.ok(done, 'the computer posts its final tag');
  assert.equal(doneConfirmed(expectedDone, done.body.tag), true);
  // Its first report carries the verified manifest version.
  const report = calls.find((c) => c.path === '/machine/me' && c.method === 'PATCH');
  assert.equal(report?.body.manifestVersion, 2);
});

test('a mistyped code ends on the phone before anything is signed', async () => {
  const { code, calls, config, printed, signed } = await run({ typedSecret: true });
  assert.equal(code, 2);
  assert.equal(signed, false);
  assert.equal(config.machineToken, undefined);
  assert.ok(!calls.some((c) => c.path === '/machine/me/ceremony'));
  assert.match(printed, /did not match/);
});

test('a second answer for the same code ends the pairing', async () => {
  const { code, calls, config, printed } = await run({ tamper: { secondAnswer: true } });
  assert.equal(code, 2);
  assert.equal(calls.filter((c) => c.path === '/pair/pr_1/confirm').length, 1);
  assert.equal(config.machineToken, undefined);
  assert.match(printed, /did not match/);
});

test('an approval altered on the way is refused and the computer revokes itself', async () => {
  for (const tamper of [
    { approval: { tag: 'A'.repeat(86) } },
    { manifests: (chain) => chain.slice(0, 1) },
  ]) {
    const { code, calls, config, printed } = await run({ tamper });
    assert.equal(code, 2);
    assert.ok(calls.some((c) => c.path === '/machine/me' && c.method === 'DELETE'));
    assert.equal(config.machineToken, undefined);
    assert.match(printed, /could not be verified/);
  }
});

test('a manifest pinned by CLI 0.4 or earlier is not trusted, so the computer pairs again', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'greatping-legacy-'));
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  try {
    mkdirSync(join(root, '.config/greatping'), { recursive: true });
    const legacy = {
      apiUrl: DEFAULT_API_URL,
      machineId: 'mch_1',
      machineToken: 'mc_token',
      keys: { sign: 'a', enc: 'b' },
      manifest: { account: 'acc_1', version: 2 },
    };
    writeFileSync(join(root, '.config/greatping/config.json'), JSON.stringify(legacy));
    assert.equal(loadConfig().manifest, undefined);
    writeFileSync(
      join(root, '.config/greatping/config.json'),
      JSON.stringify({ ...legacy, manifestEncoding: 2 }),
    );
    assert.equal(loadConfig().manifest?.version, 2);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lost final confirmation is retained and recovered without a second pairing', async () => {
  const { code, retryCode, calls, initialConfig, config, expectedDone, firstPrinted } = await run({
    tamper: { failDone: true },
  });
  assert.equal(code, 1);
  assert.equal(initialConfig.pendingCeremonyTag, expectedDone);
  assert.doesNotMatch(firstPrinted, /Paired .*Test Mac/);
  assert.match(firstPrinted, /confirmation.*pending/i);
  assert.equal(retryCode, 0);
  const confirmedAt = calls.findLastIndex((call) => call.path === '/machine/me/ceremony');
  assert.ok(
    calls.slice(confirmedAt).some((call) => call.path === '/machine/me' && call.method === 'PATCH'),
  );
  assert.equal(config.pendingCeremonyTag, undefined);
  assert.equal(config.machineToken, 'mc_token');
  const done = calls.filter((call) => call.path === '/machine/me/ceremony');
  assert.equal(done.length, 2);
  assert.deepEqual(done[0].body, done[1].body);
  assert.equal(calls.filter((call) => call.path === '/pair/start').length, 1);
});

test('background reporting replays the exact pending M5 from reopened config', async () => {
  const { code, initialConfig, config, calls } = await run({
    tamper: { failDone: true },
    backgroundRetry: true,
  });
  assert.equal(code, 1);
  assert.ok(initialConfig.pendingCeremonyTag);
  assert.equal(config.pendingCeremonyTag, undefined);
  assert.equal(calls.filter((c) => c.path === '/pair/start').length, 1);
  assert.deepEqual(
    calls.filter((c) => c.path === '/machine/me/ceremony').map((c) => c.body.tag),
    [initialConfig.pendingCeremonyTag, initialConfig.pendingCeremonyTag],
  );
});

test('an acknowledged M5 cannot restore a pairing removed locally while in flight', async () => {
  const { code, config, printed } = await run({ localLogout: true });
  assert.equal(code, 1);
  assert.equal(config.machineToken, undefined);
  assert.doesNotMatch(printed, /Alerts now reach/);
});

test('a revoked computer offers re-pairing instead of retrying an impossible M5', async () => {
  const { code, retryCode, printed, calls } = await run({
    tamper: { revokedDone: true, failDone: true },
  });
  assert.equal(code, 1);
  assert.equal(retryCode, 1);
  assert.match(printed, /no longer paired/);
  assert.match(printed, /greatping logout.*greatping login/);
  assert.doesNotMatch(printed, /confirmation is pending/);
  assert.equal(calls.filter((c) => c.path === '/pair/start').length, 1);
});
