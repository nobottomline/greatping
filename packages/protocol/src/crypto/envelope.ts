import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { ALERT_HOSTS, ATTENTION_REASONS, LIMITS } from '../constants';
import { fromBase64Url, fromUtf8, lvCat, toBase64Url, utf8 } from './bytes';
import type { RandomBytes } from './cpace';
import { openBase, sealBase } from './hpke';
import { ENC_ALG, type SecretKeys, signBytes, verifyBytes } from './keys';
import type { Manifest, Member, MemberKind } from './manifest';

/**
 * Signed, multi-recipient envelopes for end-to-end encrypted content
 * (docs/e2e-encryption.md). The content is encrypted once under a random
 * content key; the key is wrapped with HPKE for each recipient of the sender's
 * verified manifest; the sender signs the header, the recipient list and the
 * ciphertext. A recipient verifies the signature before decrypting anything.
 */

export const E2E_SUITE = 'gp-e2e-1';
export const ENVELOPE_PURPOSES = ['request', 'answer', 'projects', 'project'] as const;
export type EnvelopePurpose = (typeof ENVELOPE_PURPOSES)[number];
export const CATEGORY_HINTS = ['yes_no', 'yes_no_text', 'text', 'choices', 'choices_text'] as const;
export type CategoryHint = (typeof CATEGORY_HINTS)[number];
/** How far the sender's clock may be from the server's creation time. */
export const ENVELOPE_MAX_SKEW_MS = 10 * 60 * 1000;
/** Upper bound of a ciphertext, far above the largest valid payload. */
const MAX_CIPHERTEXT_BYTES = 32 * 1024;

const LABEL = 'GreatPing e2e v1';
const WRAP_LABEL = 'GreatPing e2e v1 wrap';
const SIG_LABEL = 'GreatPing e2e v1 sig';
const ZERO_NONCE = new Uint8Array(12);

/** The kind of member that may send each purpose, and the signed metadata fields in order. */
const PURPOSES: Record<EnvelopePurpose, { sender: MemberKind; meta: readonly string[] }> = {
  request: { sender: 'computer', meta: ['kind', 'host', 'reason', 'projectKey', 'hint'] },
  answer: { sender: 'device', meta: ['kind'] },
  projects: { sender: 'computer', meta: [] },
  project: { sender: 'device', meta: ['projectKey'] },
};

const memberId = z.string().regex(/^[\w-]{1,64}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const b64 = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((text) => decodedLength(text) === bytes, `expected ${bytes} bytes`);

function decodedLength(text: string): number {
  try {
    return fromBase64Url(text).length;
  } catch {
    return -1;
  }
}

const metaSchemas = {
  request: z.strictObject({
    kind: z.enum(['attention', 'ask', 'notify']),
    host: z.enum(ALERT_HOSTS),
    reason: z.enum(ATTENTION_REASONS).optional(),
    projectKey: opaqueId.optional(),
    hint: z.enum(CATEGORY_HINTS).optional(),
  }),
  answer: z.strictObject({ kind: z.literal('ask') }),
  projects: z.strictObject({}),
  project: z.strictObject({ projectKey: opaqueId }),
} as const;

export type EnvelopeMeta = {
  [P in EnvelopePurpose]: z.infer<(typeof metaSchemas)[P]>;
};

const recipientSchema = z.strictObject({
  id: memberId,
  kid: b64(16),
  enc: b64(32),
  key: b64(48),
});

/** The envelope's shape and sizes; what it says is decided by `openEnvelope`. */
export const envelopeSchema = z.strictObject({
  v: z.literal(1),
  suite: z.literal(E2E_SUITE),
  id: b64(16),
  purpose: z.enum(ENVELOPE_PURPOSES),
  sender: memberId,
  manifest: z.number().int().min(1),
  at: z.number().int().min(0),
  ref: b64(16).optional(),
  meta: z.record(z.string(), z.string()),
  recipients: z.array(recipientSchema).min(1).max(LIMITS.manifestMembersMax),
  ct: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((text) => {
      const n = decodedLength(text);
      return n >= 16 && n <= MAX_CIPHERTEXT_BYTES;
    }, 'invalid ciphertext'),
  sig: b64(64),
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeRecipient = Envelope['recipients'][number];

const label = z.string().min(1).max(LIMITS.projectLabelMaxLength);
const choices = z
  .array(z.string().min(1).max(LIMITS.choiceMaxLength))
  .max(LIMITS.choicesMax)
  .refine((list) => new Set(list).size === list.length, 'choices must be unique');

const payloadSchemas = {
  request: z.strictObject({
    title: z.string().min(1).max(100).optional(),
    body: z.string().min(1).max(LIMITS.bodyMaxLength).optional(),
    choices: choices.optional(),
    allowText: z.boolean().optional(),
    projectLabel: label.optional(),
  }),
  answer: z
    .strictObject({
      choice: z.string().min(1).max(LIMITS.choiceMaxLength).optional(),
      text: z.string().min(1).max(LIMITS.answerTextMaxLength).optional(),
    })
    .refine((a) => (a.choice === undefined) !== (a.text === undefined), 'one of choice or text'),
  /** The computer's recent projects: folder name, a name set from a device, hidden. */
  projects: z.strictObject({
    projects: z
      .array(
        z.strictObject({
          key: opaqueId,
          label,
          name: label.optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .max(50),
  }),
  /** A device renames (null: back to the folder name) or hides one project. */
  project: z
    .strictObject({ name: label.nullable().optional(), hidden: z.boolean().optional() })
    .refine((p) => p.name !== undefined || p.hidden !== undefined, 'name or hidden'),
} as const;

export type EnvelopePayload = {
  [P in EnvelopePurpose]: z.infer<(typeof payloadSchemas)[P]>;
};

export type EnvelopeErrorCode =
  | 'malformed'
  | 'unsupported'
  | 'not_addressed'
  | 'stale'
  | 'unknown_sender'
  | 'bad_signature'
  | 'decrypt_failed'
  | 'mismatch';

/** Never carries content, so it is safe to log and report. */
export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode) {
    super(`envelope rejected: ${code}`);
  }
}

/** First 16 bytes of SHA-256 over a raw X25519 public key. */
export function kidOf(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey).slice(0, 16);
}

const secretKids = new WeakMap<Uint8Array, string>();

/** The `kid` of one's own secret key, computed once per key object. */
function kidOfSecret(secret: Uint8Array): string {
  let kid = secretKids.get(secret);
  if (!kid) {
    kid = toBase64Url(kidOf(x25519.getPublicKey(secret)));
    secretKids.set(secret, kid);
  }
  return kid;
}

/** Who receives a purpose: every device, plus the computer for answers and project settings. */
export function recipientsFor(
  purpose: EnvelopePurpose,
  manifest: Manifest,
  computerId?: string,
): Member[] {
  const devices = manifest.members.filter((m) => m.kind === 'device');
  if (purpose === 'request' || purpose === 'projects') return devices;
  const computer = manifest.members.find((m) => m.id === computerId && m.kind === 'computer');
  if (!computer) throw new Error('the computer is not a member of the manifest');
  return [...devices, computer].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Request payload rules that depend on the signed kind. */
function checkRequest(kind: string, payload: EnvelopePayload['request']): boolean {
  if (kind === 'attention')
    return Object.keys(payload).length === 1 && payload.projectLabel !== undefined;
  if (payload.body === undefined) return false;
  if (kind === 'notify') return payload.choices === undefined && payload.allowText === undefined;
  return true;
}

function metaBytes(purpose: EnvelopePurpose, meta: Record<string, string>): Uint8Array {
  return lvCat(...PURPOSES[purpose].meta.map((field) => utf8(meta[field] ?? '')));
}

interface Header {
  id: string;
  purpose: EnvelopePurpose;
  sender: string;
  manifest: number;
  at: number;
  ref?: string | undefined;
  meta: Record<string, string>;
}

/** `C` of the specification: the context every wrap, the content and the signature bind. */
function contextHash(accountId: string, h: Header): Uint8Array {
  return sha256(
    lvCat(
      utf8(LABEL),
      utf8(E2E_SUITE),
      fromBase64Url(h.id),
      utf8(h.purpose),
      utf8(accountId),
      utf8(h.sender),
      utf8(String(h.manifest)),
      utf8(String(h.at)),
      h.ref === undefined ? new Uint8Array(0) : fromBase64Url(h.ref),
      metaBytes(h.purpose, h.meta),
    ),
  );
}

function recipientsHash(recipients: EnvelopeRecipient[]): Uint8Array {
  return sha256(
    lvCat(
      ...recipients.map((r) =>
        lvCat(utf8(r.id), fromBase64Url(r.kid), fromBase64Url(r.enc), fromBase64Url(r.key)),
      ),
    ),
  );
}

function signedBytes(context: Uint8Array, recipients: EnvelopeRecipient[], ct: Uint8Array) {
  return lvCat(utf8(SIG_LABEL), context, recipientsHash(recipients), sha256(ct));
}

const wrapInfo = (context: Uint8Array) => lvCat(utf8(WRAP_LABEL), context);

/**
 * The intermediate values of an envelope (`M`, `C`, `R` and the signed bytes of
 * the specification), for test vectors of other implementations.
 */
export function envelopeTranscript(envelope: Envelope, accountId: string) {
  const context = contextHash(accountId, envelope);
  return {
    meta: metaBytes(envelope.purpose, envelope.meta),
    context,
    recipients: recipientsHash(envelope.recipients),
    signed: signedBytes(context, envelope.recipients, fromBase64Url(envelope.ct)),
  };
}

/** Drops absent optional fields so the signed metadata has one form. */
function cleanMeta(meta: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(meta).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function sealEnvelope<P extends EnvelopePurpose>(input: {
  purpose: P;
  accountId: string;
  sender: { id: string; secret: SecretKeys };
  /** The sender's latest verified manifest; recipients must come from it. */
  manifest: Manifest;
  recipients: Member[];
  meta: EnvelopeMeta[P];
  payload: EnvelopePayload[P];
  /** Answers: the `id` of the question's envelope. */
  ref?: string | undefined;
  now: number;
  random: RandomBytes;
}): Envelope {
  const meta = cleanMeta(metaSchemas[input.purpose].parse(input.meta));
  const payload = payloadSchemas[input.purpose].parse(input.payload);
  if (input.purpose === 'request' && !checkRequest(meta.kind as string, payload as never))
    throw new Error('payload does not fit the request kind');
  if ((input.purpose === 'answer') !== (input.ref !== undefined))
    throw new Error('only answers carry a ref');
  const sender = input.manifest.members.find((m) => m.id === input.sender.id);
  if (sender?.kind !== PURPOSES[input.purpose].sender)
    throw new Error('the sender cannot send this purpose');
  const ids = input.recipients.map((r) => r.id);
  if (ids.length === 0 || ids.some((id, i) => i > 0 && (ids[i - 1] as string) >= id))
    throw new Error('recipients must be sorted and unique');
  const header: Header = {
    id: toBase64Url(input.random(16)),
    purpose: input.purpose,
    sender: input.sender.id,
    manifest: input.manifest.version,
    at: input.now,
    ...(input.ref === undefined ? {} : { ref: input.ref }),
    meta,
  };
  const context = contextHash(input.accountId, header);
  const contentKey = input.random(32);
  if (contentKey.length !== 32) throw new Error('random source returned a wrong length');
  const ct = chacha20poly1305(contentKey, ZERO_NONCE, context).encrypt(
    utf8(JSON.stringify(payload)),
  );
  const recipients = input.recipients.map((member): EnvelopeRecipient => {
    if (member.enc.alg !== ENC_ALG) throw new Error('unsupported recipient key');
    const publicKey = fromBase64Url(member.enc.key);
    const wrapped = sealBase({
      recipientPublic: publicKey,
      info: wrapInfo(context),
      aad: utf8(member.id),
      plaintext: contentKey,
      random: input.random,
    });
    return {
      id: member.id,
      kid: toBase64Url(kidOf(publicKey)),
      enc: toBase64Url(wrapped.enc),
      key: toBase64Url(wrapped.ciphertext),
    };
  });
  const sig = signBytes(input.sender.secret, signedBytes(context, recipients, ct));
  return {
    v: 1,
    suite: E2E_SUITE,
    ...header,
    recipients,
    ct: toBase64Url(ct),
    sig,
  } as Envelope;
}

/** What the server says about the envelope, checked against the signed fields. */
export interface EnvelopeExpectation {
  purpose: EnvelopePurpose;
  meta?: Record<string, string | undefined>;
  /** The server's creation time of the request or report. */
  createdAt?: number;
  /** Answers: the question envelope's `id`. */
  ref?: string | undefined;
}

export function openEnvelope<P extends EnvelopePurpose>(input: {
  envelope: unknown;
  accountId: string;
  me: { id: string; encSecrets: readonly Uint8Array[] };
  /** The latest manifest this member verified. */
  manifest: Manifest;
  expect: EnvelopeExpectation & { purpose: P };
}): { payload: EnvelopePayload[P]; envelope: Envelope; sender: Member } {
  // 1. Parse strictly; an unknown version or suite is unsupported, not malformed.
  const raw = input.envelope as { v?: unknown; suite?: unknown } | null;
  if (
    raw &&
    typeof raw === 'object' &&
    ((raw.v !== undefined && raw.v !== 1) ||
      (typeof raw.suite === 'string' && raw.suite !== E2E_SUITE))
  )
    throw new EnvelopeError('unsupported');
  const parsed = envelopeSchema.safeParse(input.envelope);
  if (!parsed.success) throw new EnvelopeError('malformed');
  const envelope = parsed.data;
  const purpose = envelope.purpose;
  const meta = metaSchemas[purpose].safeParse(envelope.meta);
  if (!meta.success) throw new EnvelopeError('malformed');
  if ((purpose === 'answer') !== (envelope.ref !== undefined)) throw new EnvelopeError('malformed');
  const ids = envelope.recipients.map((r) => r.id);
  if (ids.some((id, i) => i > 0 && (ids[i - 1] as string) >= id))
    throw new EnvelopeError('malformed');
  if (purpose !== input.expect.purpose) throw new EnvelopeError('mismatch');

  // 2. The own entry, with a key this member holds.
  const own = envelope.recipients.find((r) => r.id === input.me.id);
  const secret = own && input.me.encSecrets.find((key) => kidOfSecret(key) === own.kid);
  if (!own || !secret) throw new EnvelopeError('not_addressed');

  // 3. The sender, from the latest verified manifest.
  if (envelope.manifest > input.manifest.version) throw new EnvelopeError('stale');
  const sender = input.manifest.members.find((m) => m.id === envelope.sender);
  if (sender?.kind !== PURPOSES[purpose].sender) throw new EnvelopeError('unknown_sender');

  // 4. The signature, before any decryption.
  const context = contextHash(input.accountId, envelope);
  const ct = fromBase64Url(envelope.ct);
  if (!verifyBytes(sender.sign, signedBytes(context, envelope.recipients, ct), envelope.sig))
    throw new EnvelopeError('bad_signature');

  // 5. The content key, then the content.
  let plaintext: Uint8Array;
  try {
    const contentKey = openBase({
      enc: fromBase64Url(own.enc),
      recipientSecret: secret,
      info: wrapInfo(context),
      aad: utf8(own.id),
      ciphertext: fromBase64Url(own.key),
    });
    plaintext = chacha20poly1305(contentKey, ZERO_NONCE, context).decrypt(ct);
  } catch {
    throw new EnvelopeError('decrypt_failed');
  }

  // 6. The payload.
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(plaintext));
  } catch {
    throw new EnvelopeError('malformed');
  }
  const payload = payloadSchemas[purpose].safeParse(json);
  if (!payload.success) throw new EnvelopeError('malformed');
  if (purpose === 'request' && !checkRequest(envelope.meta.kind as string, payload.data as never))
    throw new EnvelopeError('malformed');

  // 7. What the server says must match what the sender signed.
  const expect = input.expect;
  if (expect.meta) {
    const fields = PURPOSES[purpose].meta;
    const expected = cleanMeta(expect.meta);
    if (fields.some((field) => (expected[field] ?? '') !== (envelope.meta[field] ?? '')))
      throw new EnvelopeError('mismatch');
  }
  if (
    expect.createdAt !== undefined &&
    Math.abs(envelope.at - expect.createdAt) > ENVELOPE_MAX_SKEW_MS
  )
    throw new EnvelopeError('mismatch');
  if (expect.ref !== undefined && envelope.ref !== expect.ref) throw new EnvelopeError('mismatch');

  return { payload: payload.data as EnvelopePayload[P], envelope, sender };
}
