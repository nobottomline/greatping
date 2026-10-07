import { expect, it } from 'vitest';
import {
  addMember,
  createGenesis,
  type Envelope,
  EnvelopeError,
  envelopeTranscript,
  fromBase64Url,
  generateKeys,
  type KeyPairs,
  type Manifest,
  openEnvelope,
  recipientsFor,
  removeMember,
  sealEnvelope,
  toBase64Url,
  toHex,
} from '../src/crypto';

/**
 * Cross-implementation vectors for envelope v1 (docs/e2e-encryption.md),
 * consumed by the iOS notification extension's tests. Everything is
 * deterministic; run `vitest run -u` to rewrite the file after an intended
 * change, and review the diff.
 */

/** A deterministic byte stream; vectors only, never for real keys. */
function stream(seed: number) {
  let counter = seed;
  return (n: number) =>
    Uint8Array.from({ length: n }, () => {
      counter = (counter * 1103515245 + 12345) >>> 0;
      return counter >>> 24;
    });
}

const keys = (seed: number): KeyPairs => generateKeys(stream(seed));
const ACCOUNT = 'acc_vectors';
const T0 = 1_790_000_000_000;
const NOW = T0 + 10 * 24 * 3600 * 1000;
const phone = { id: 'dev_phone', ...keys(1) };
const tablet = { id: 'dev_tablet', ...keys(2) };
const mac = { id: 'mch_mac', ...keys(3) };

function manifest(): Manifest {
  const signer = { id: phone.id, secret: phone.secret };
  const genesis = createGenesis({
    account: ACCOUNT,
    device: phone.id,
    keys: phone.public,
    secret: phone.secret,
    createdAt: T0,
  });
  const withMac = addMember(
    genesis,
    signer,
    { kind: 'computer', id: mac.id, ...mac.public },
    T0 + 1,
  );
  return addMember(withMac, signer, { kind: 'device', id: tablet.id, ...tablet.public }, T0 + 2);
}

const m = manifest();
const members = (from: Manifest) =>
  from.members.map((x) => ({ id: x.id, kind: x.kind, sign: x.sign.key, enc: x.enc.key }));

function seal(
  seed: number,
  meta: Parameters<typeof sealEnvelope<'request'>>[0]['meta'],
  payload: Parameters<typeof sealEnvelope<'request'>>[0]['payload'],
) {
  return sealEnvelope({
    purpose: 'request',
    accountId: ACCOUNT,
    sender: { id: mac.id, secret: mac.secret },
    manifest: m,
    recipients: recipientsFor('request', m),
    meta,
    payload,
    now: NOW,
    random: stream(seed),
  });
}

function flip(text: string): string {
  const bytes = fromBase64Url(text);
  bytes[0] = (bytes[0] as number) ^ 1;
  return toBase64Url(bytes);
}

function build() {
  const ask = { kind: 'ask', host: 'claude-code', hint: 'yes_no_text' } as const;
  const attention = {
    kind: 'attention',
    host: 'codex',
    reason: 'finished',
    projectKey: 'proj_0123456789',
  } as const;
  const notify = { kind: 'notify', host: 'cli' } as const;
  const question = seal(100, ask, {
    title: 'Deploy',
    body: 'Ship build 42 to production?',
    choices: ['Yes', 'No'],
    allowText: true,
  });
  const cases: Array<{
    name: string;
    recipient: string;
    members?: ReturnType<typeof members>;
    envelope: unknown;
    expect: { meta: Record<string, string>; createdAt: number };
    payload?: unknown;
    error?: string;
  }> = [
    {
      name: 'question',
      recipient: phone.id,
      envelope: question,
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'question, second device',
      recipient: tablet.id,
      envelope: question,
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'attention with project label',
      recipient: phone.id,
      envelope: seal(200, attention, { projectLabel: 'billing-api' }),
      expect: { meta: attention, createdAt: NOW },
    },
    {
      name: 'message with non-ASCII text',
      recipient: tablet.id,
      envelope: seal(300, notify, { title: 'Готово 🚀', body: 'Сборка прошла. 构建成功。' }),
      expect: { meta: notify, createdAt: NOW },
    },
    {
      name: 'changed ciphertext',
      recipient: phone.id,
      envelope: { ...question, ct: flip(question.ct) },
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'changed wrapped key',
      recipient: phone.id,
      envelope: {
        ...question,
        recipients: question.recipients.map((r) =>
          r.id === phone.id ? { ...r, key: flip(r.key) } : r,
        ),
      },
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'changed signed metadata',
      recipient: phone.id,
      envelope: { ...question, meta: { ...question.meta, hint: 'yes_no' } },
      expect: { meta: { ...ask, hint: 'yes_no' }, createdAt: NOW },
    },
    {
      name: 'server metadata differs',
      recipient: phone.id,
      envelope: question,
      expect: { meta: { ...ask, kind: 'notify' }, createdAt: NOW },
    },
    {
      name: 'sender clock too far from the server',
      recipient: phone.id,
      envelope: question,
      expect: { meta: ask, createdAt: NOW + 11 * 60 * 1000 },
    },
    {
      name: 'not addressed',
      recipient: mac.id,
      envelope: question,
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'sender removed',
      recipient: phone.id,
      members: members(removeMember(m, { id: phone.id, secret: phone.secret }, mac.id, NOW)),
      envelope: question,
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'unknown suite',
      recipient: phone.id,
      envelope: { ...question, suite: 'gp-e2e-2' },
      expect: { meta: ask, createdAt: NOW },
    },
    {
      name: 'unknown field',
      recipient: phone.id,
      envelope: { ...question, note: 'x' },
      expect: { meta: ask, createdAt: NOW },
    },
  ];
  const secrets: Record<string, KeyPairs> = {
    [phone.id]: phone,
    [tablet.id]: tablet,
    [mac.id]: mac,
  };
  for (const c of cases) {
    const own = secrets[c.recipient] as KeyPairs;
    const memberList = c.members ?? members(m);
    // The opening rules see members only as the extension's state does.
    const view: Manifest = {
      ...m,
      members: m.members.filter((x) => memberList.some((y) => y.id === x.id)),
    };
    try {
      c.payload = openEnvelope({
        envelope: c.envelope,
        accountId: ACCOUNT,
        me: { id: c.recipient, encSecrets: [own.secret.enc] },
        manifest: view,
        expect: { purpose: 'request', ...c.expect },
      }).payload;
    } catch (error) {
      if (!(error instanceof EnvelopeError)) throw error;
      c.error = error.code;
    }
  }
  const t = envelopeTranscript(question, ACCOUNT);
  return {
    description:
      "GreatPing envelope v1 vectors (docs/e2e-encryption.md). Each case opens `envelope` as `recipient` with that member's X25519 secret, the members listed (the extension state) and the server-visible expectation; the result is `payload` or the error `code`.",
    suite: 'gp-e2e-1',
    accountId: ACCOUNT,
    manifestVersion: m.version,
    members: members(m),
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([id, k]) => [
        id,
        { enc: toHex(k.secret.enc), sign: toHex(k.secret.sign) },
      ]),
    ),
    transcript: {
      case: 'question',
      M: toHex(t.meta),
      C: toHex(t.context),
      R: toHex(t.recipients),
      signed: toHex(t.signed),
    },
    cases,
  };
}

it('the committed vectors match this implementation', async () => {
  await expect(`${JSON.stringify(build(), null, 2)}
`).toMatchFileSnapshot('./vectors/e2e-v1.json');
});

it('the vectors exercise every opening outcome the extension handles', () => {
  const outcomes = new Set(build().cases.map((c) => c.error ?? 'ok'));
  for (const outcome of [
    'ok',
    'bad_signature',
    'mismatch',
    'not_addressed',
    'unknown_sender',
    'unsupported',
    'malformed',
  ])
    expect(outcomes).toContain(outcome);
  const first = build().cases[0] as { envelope: Envelope; payload: unknown };
  expect(first.payload).toEqual({
    title: 'Deploy',
    body: 'Ship build 42 to production?',
    choices: ['Yes', 'No'],
    allowText: true,
  });
});
