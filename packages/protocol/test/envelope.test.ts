import { describe, expect, it } from 'vitest';
import {
  addMember,
  createGenesis,
  type Envelope,
  EnvelopeError,
  type EnvelopeErrorCode,
  fromBase64Url,
  fromHex,
  fromUtf8,
  generateKeys,
  type KeyPairs,
  type Manifest,
  openEnvelope,
  recipientsFor,
  removeMember,
  sealEnvelope,
  toBase64Url,
  utf8,
  validMemberKeys,
} from '../src/crypto';

/** Deterministic keys, as in the manifest tests. */
function keys(seed: number): KeyPairs {
  let counter = seed * 1000;
  return generateKeys((n) => Uint8Array.from({ length: n }, () => counter++ & 0xff));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const HOUR = 3600 * 1000;
const T0 = 1_790_000_000_000;
const NOW = T0 + 10 * 24 * HOUR;
const ACCOUNT = 'acc_1';
const phone = { id: 'dev_phone', ...keys(1) };
const tablet = { id: 'dev_tablet', ...keys(2) };
const mac = { id: 'mch_mac', ...keys(3) };
const stranger = { id: 'dev_stranger', ...keys(4) };

function manifest(): Manifest {
  const genesis = createGenesis({
    account: ACCOUNT,
    device: phone.id,
    keys: phone.public,
    secret: phone.secret,
    createdAt: T0,
  });
  const withMac = addMember(
    genesis,
    { id: phone.id, secret: phone.secret },
    { kind: 'computer', id: mac.id, ...mac.public },
    T0 + HOUR,
  );
  return addMember(
    withMac,
    { id: phone.id, secret: phone.secret },
    { kind: 'device', id: tablet.id, ...tablet.public },
    T0 + 2 * HOUR,
  );
}

const m = manifest();
const question = { kind: 'ask', host: 'claude-code', hint: 'yes_no_text' } as const;

function sealQuestion(overrides: Partial<Parameters<typeof sealEnvelope<'request'>>[0]> = {}) {
  return sealEnvelope({
    purpose: 'request',
    accountId: ACCOUNT,
    sender: { id: mac.id, secret: mac.secret },
    manifest: m,
    recipients: recipientsFor('request', m),
    meta: question,
    payload: {
      title: 'Deploy',
      body: 'Ship to production?',
      choices: ['Yes', 'No'],
      allowText: true,
    },
    now: NOW,
    random,
    ...overrides,
  });
}

function open(
  envelope: unknown,
  who: { id: string; secret: KeyPairs['secret'] } = phone,
  expect: Record<string, unknown> = {},
  manifestOverride: Manifest = m,
) {
  return openEnvelope({
    envelope,
    accountId: ACCOUNT,
    me: { id: who.id, encSecrets: [who.secret.enc] },
    manifest: manifestOverride,
    expect: { purpose: 'request', meta: question, createdAt: NOW, ...expect },
  });
}

function rejects(run: () => unknown, code: EnvelopeErrorCode) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvelopeError);
    expect((error as EnvelopeError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** A copy with one field changed, as a server could deliver it. */
const tamper = (e: Envelope, change: Partial<Envelope>) => ({ ...structuredClone(e), ...change });

function flip(text: string, index = 0): string {
  const bytes = fromBase64Url(text);
  bytes[index] = (bytes[index] as number) ^ 1;
  return toBase64Url(bytes);
}

describe('sealed content round trip', () => {
  it('every device opens a question; the computer is not a recipient', () => {
    const envelope = sealQuestion();
    expect(envelope.recipients.map((r) => r.id)).toEqual([phone.id, tablet.id]);
    for (const device of [phone, tablet])
      expect(open(envelope, device).payload).toEqual({
        title: 'Deploy',
        body: 'Ship to production?',
        choices: ['Yes', 'No'],
        allowText: true,
      });
    rejects(() => open(envelope, mac), 'not_addressed');
  });

  it('an answer reaches the computer and every device, bound to its question', () => {
    const q = sealQuestion();
    const answer = sealEnvelope({
      purpose: 'answer',
      accountId: ACCOUNT,
      sender: { id: tablet.id, secret: tablet.secret },
      manifest: m,
      recipients: recipientsFor('answer', m, mac.id),
      meta: { kind: 'ask' },
      payload: { text: 'after lunch' },
      ref: q.id,
      now: NOW + 1000,
      random,
    });
    expect(answer.recipients.map((r) => r.id)).toEqual([phone.id, tablet.id, mac.id]);
    const opened = openEnvelope({
      envelope: answer,
      accountId: ACCOUNT,
      me: { id: mac.id, encSecrets: [mac.secret.enc] },
      manifest: m,
      expect: { purpose: 'answer', ref: q.id, createdAt: NOW },
    });
    expect(opened.payload).toEqual({ text: 'after lunch' });
    expect(opened.sender.id).toBe(tablet.id);
    rejects(
      () =>
        openEnvelope({
          envelope: answer,
          accountId: ACCOUNT,
          me: { id: mac.id, encSecrets: [mac.secret.enc] },
          manifest: m,
          expect: { purpose: 'answer', ref: sealQuestion().id },
        }),
      'mismatch',
    );
  });

  it('projects and project settings', () => {
    const projects = sealEnvelope({
      purpose: 'projects',
      accountId: ACCOUNT,
      sender: { id: mac.id, secret: mac.secret },
      manifest: m,
      recipients: recipientsFor('projects', m),
      meta: {},
      payload: { projects: [{ key: 'proj_12345678', label: 'billing-api', name: 'Billing' }] },
      now: NOW,
      random,
    });
    expect(
      openEnvelope({
        envelope: projects,
        accountId: ACCOUNT,
        me: { id: phone.id, encSecrets: [phone.secret.enc] },
        manifest: m,
        expect: { purpose: 'projects' },
      }).payload.projects[0]?.label,
    ).toBe('billing-api');
    const setting = sealEnvelope({
      purpose: 'project',
      accountId: ACCOUNT,
      sender: { id: phone.id, secret: phone.secret },
      manifest: m,
      recipients: recipientsFor('project', m, mac.id),
      meta: { projectKey: 'proj_12345678' },
      payload: { name: null, hidden: true },
      now: NOW,
      random,
    });
    expect(
      openEnvelope({
        envelope: setting,
        accountId: ACCOUNT,
        me: { id: mac.id, encSecrets: [mac.secret.enc] },
        manifest: m,
        expect: { purpose: 'project', meta: { projectKey: 'proj_12345678' } },
      }).payload,
    ).toEqual({ name: null, hidden: true });
  });

  it('an attention alert carries only its project label', () => {
    const envelope = sealQuestion({
      meta: { kind: 'attention', host: 'codex', reason: 'finished', projectKey: 'proj_12345678' },
      payload: { projectLabel: 'billing-api' },
    });
    expect(
      open(envelope, phone, {
        meta: { kind: 'attention', host: 'codex', reason: 'finished', projectKey: 'proj_12345678' },
      }).payload,
    ).toEqual({ projectLabel: 'billing-api' });
    expect(() =>
      sealQuestion({
        meta: { kind: 'attention', host: 'codex', reason: 'finished' },
        payload: { projectLabel: 'x', body: 'leak' },
      }),
    ).toThrow();
  });

  it('the largest question for three devices stays within the push budget', () => {
    const many = addMember(
      m,
      { id: phone.id, secret: phone.secret },
      { kind: 'device', id: 'dev_third', ...keys(5).public },
      NOW - HOUR,
    );
    const envelope = sealEnvelope({
      purpose: 'request',
      accountId: ACCOUNT,
      sender: { id: mac.id, secret: mac.secret },
      manifest: many,
      recipients: recipientsFor('request', many),
      meta: question,
      payload: {
        title: 'T'.repeat(100),
        body: 'B'.repeat(1000),
        choices: Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(80, 'c')),
        allowText: true,
        projectLabel: 'L'.repeat(60),
      },
      now: NOW,
      random,
    });
    const size = utf8(JSON.stringify(envelope)).length;
    expect(size).toBeLessThan(3500);
  });
});

describe('attacks', () => {
  const envelope = sealQuestion();

  it('a member that is not addressed, or a key it does not hold', () => {
    rejects(() => open(envelope, stranger), 'not_addressed');
    rejects(
      () =>
        openEnvelope({
          envelope,
          accountId: ACCOUNT,
          me: { id: phone.id, encSecrets: [tablet.secret.enc] },
          manifest: m,
          expect: { purpose: 'request' },
        }),
      'not_addressed',
    );
  });

  it('a changed byte anywhere in the signed parts', () => {
    const changes: Partial<Envelope>[] = [
      { id: flip(envelope.id) },
      { at: envelope.at + 1 },
      { manifest: envelope.manifest - 1 },
      { ct: flip(envelope.ct) },
      { ct: flip(envelope.ct, fromBase64Url(envelope.ct).length - 1) },
      { meta: { ...envelope.meta, hint: 'text' } },
      { recipients: envelope.recipients.map((r, i) => (i === 1 ? { ...r, key: flip(r.key) } : r)) },
      { recipients: envelope.recipients.map((r, i) => (i === 1 ? { ...r, enc: flip(r.enc) } : r)) },
      { recipients: envelope.recipients.slice(0, 1) },
    ];
    for (const change of changes) rejects(() => open(tamper(envelope, change)), 'bad_signature');
  });

  it('a signature with S + L, which lax verifiers accept', () => {
    const sig = fromBase64Url(envelope.sig);
    // L, the order of the Ed25519 group, little-endian.
    const order = fromHex(`edd3f55c1a631258d69cf7a2def9de14${'00'.repeat(15)}10`);
    let carry = 0;
    for (let i = 0; i < 32; i++) {
      const sum = (sig[32 + i] as number) + (order[i] as number) + carry;
      sig[32 + i] = sum & 0xff;
      carry = sum >> 8;
    }
    rejects(() => open(tamper(envelope, { sig: toBase64Url(sig) })), 'bad_signature');
  });

  it('a recipient entry moved from another envelope', () => {
    const other = sealQuestion();
    const swapped = tamper(envelope, {
      recipients: envelope.recipients.map((r, i) =>
        i === 0 ? (other.recipients[0] as typeof r) : r,
      ),
    });
    rejects(() => open(swapped), 'bad_signature');
  });

  it('another account, or a server-built envelope with its own key', () => {
    rejects(
      () =>
        openEnvelope({
          envelope,
          accountId: 'acc_other',
          me: { id: phone.id, encSecrets: [phone.secret.enc] },
          manifest: m,
          expect: { purpose: 'request' },
        }),
      'bad_signature',
    );
    // The server signs as the computer with a key the manifest does not hold.
    const forged = sealEnvelope({
      purpose: 'request',
      accountId: ACCOUNT,
      sender: { id: mac.id, secret: stranger.secret },
      manifest: m,
      recipients: recipientsFor('request', m),
      meta: question,
      payload: { body: 'Approve the transfer?' },
      now: NOW,
      random,
    });
    rejects(() => open(forged), 'bad_signature');
  });

  it('a signer of the wrong kind, or one removed from the manifest', () => {
    // A device's valid signature on a request: only computers send requests.
    const asIfComputer = {
      ...m,
      members: m.members.map((x) => (x.id === phone.id ? { ...x, kind: 'computer' as const } : x)),
    };
    const fromDevice = sealEnvelope({
      purpose: 'request',
      accountId: ACCOUNT,
      sender: { id: phone.id, secret: phone.secret },
      manifest: asIfComputer,
      recipients: recipientsFor('request', m),
      meta: question,
      payload: { body: 'Approve?' },
      now: NOW,
      random,
    });
    rejects(() => open(fromDevice), 'unknown_sender');
    const withoutMac = removeMember(m, { id: phone.id, secret: phone.secret }, mac.id, NOW);
    rejects(() => open(envelope, phone, {}, withoutMac), 'unknown_sender');
  });

  it('metadata the server changed, a replay on another request, a newer manifest', () => {
    rejects(() => open(envelope, phone, { meta: { ...question, kind: 'notify' } }), 'mismatch');
    rejects(() => open(envelope, phone, { meta: { ...question, hint: 'yes_no' } }), 'mismatch');
    rejects(() => open(envelope, phone, { createdAt: NOW + 11 * 60 * 1000 }), 'mismatch');
    rejects(() => open(sealQuestion({ manifest: { ...m, version: m.version + 1 } })), 'stale');
  });

  it('unknown versions and suites, and malformed input', () => {
    rejects(() => open({ ...envelope, v: 2 }), 'unsupported');
    rejects(() => open({ ...envelope, suite: 'gp-e2e-2' }), 'unsupported');
    rejects(() => open({ ...envelope, extra: 1 }), 'malformed');
    rejects(() => open({ ...envelope, sig: 'short' }), 'malformed');
    rejects(() => open(null), 'malformed');
    rejects(() => open({}), 'malformed');
    rejects(
      () => open(tamper(envelope, { recipients: [...envelope.recipients].reverse() })),
      'malformed',
    );
  });
});

describe('strict UTF-8', () => {
  it('decodes what it encodes and refuses invalid sequences', () => {
    const text = 'Ship 🚀 to prod? Да / 是';
    expect(fromUtf8(utf8(text))).toBe(text);
    for (const bad of [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0x80],
    ])
      expect(() => fromUtf8(Uint8Array.from(bad))).toThrow();
  });
});

describe('member keys', () => {
  it('refuses a small-order Ed25519 key, so every verifier treats signatures alike', () => {
    const good = keys(7).public;
    expect(validMemberKeys(good)).toBe(true);
    // The identity point (y = 1): any signature "verifies" under it with a cofactored check.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(validMemberKeys({ ...good, sign: { alg: 'ed25519', key: toBase64Url(identity) } })).toBe(
      false,
    );
  });
});
