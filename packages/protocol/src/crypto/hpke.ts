import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes';
import type { RandomBytes } from './cpace';

/**
 * HPKE (RFC 9180) base mode for exactly one suite: DHKEM(X25519, HKDF-SHA256)
 * `0x0020`, HKDF-SHA256 `0x0001`, ChaCha20-Poly1305 `0x0003`. Only what
 * end-to-end content needs (docs/e2e-encryption.md): single-shot seal and open
 * with the first sequence number; no PSK, auth or export. Checked against the
 * RFC's Appendix A.2.1 vectors.
 */

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;
const N_SECRET = 32;
const N_KEY = 32;
const N_NONCE = 12;
const MODE_BASE = 0x00;

function i2osp(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  if (rest !== 0) throw new RangeError('value does not fit');
  return out;
}

const KEM_SUITE = concat(utf8('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE = concat(utf8('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const VERSION = utf8('HPKE-v1');
const EMPTY = new Uint8Array(0);

/** RFC 9180 §4: LabeledExtract and LabeledExpand. */
function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) {
  return extract(sha256, concat(VERSION, suite, utf8(label), ikm), salt);
}

function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) {
  return expand(sha256, prk, concat(i2osp(length, 2), VERSION, suite, utf8(label), info), length);
}

/** RFC 9180 §4.1: X25519 DH, rejecting the all-zero output of a small-order point. */
function dh(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new HpkeError('invalid public key');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secret, publicKey);
  } catch {
    throw new HpkeError('invalid public key');
  }
  if (shared.every((byte) => byte === 0)) throw new HpkeError('invalid public key');
  return shared;
}

function sharedSecret(dhResult: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dhResult);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', concat(enc, pkR), N_SECRET);
}

/** RFC 9180 §7.1.3: DeriveKeyPair for X25519; the ephemeral key of the vectors. */
export function deriveKeyPair(ikm: Uint8Array): { secret: Uint8Array; public: Uint8Array } {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm);
  const secret = labeledExpand(KEM_SUITE, prk, 'sk', EMPTY, 32);
  return { secret, public: x25519.getPublicKey(secret) };
}

/** RFC 9180 §5.1: the base-mode key schedule. */
function keySchedule(shared: Uint8Array, info: Uint8Array) {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, N_KEY),
    baseNonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_NONCE),
  };
}

/** RFC 9180 §5.2: the nonce of sequence number `seq`. */
function nonceFor(baseNonce: Uint8Array, seq: number): Uint8Array {
  const counter = i2osp(seq, N_NONCE);
  return baseNonce.map((byte, i) => byte ^ (counter[i] as number));
}

export class HpkeError extends Error {}

/** An encryption context; tests use it for the RFC's later sequence numbers. */
export interface HpkeContext {
  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

function context(shared: Uint8Array, info: Uint8Array): HpkeContext {
  const { key, baseNonce } = keySchedule(shared, info);
  let seq = 0;
  const next = () => nonceFor(baseNonce, seq++);
  return {
    seal: (aad, plaintext) => chacha20poly1305(key, next(), aad).encrypt(plaintext),
    open: (aad, ciphertext) => {
      const nonce = nonceFor(baseNonce, seq);
      let plaintext: Uint8Array;
      try {
        plaintext = chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
      } catch {
        throw new HpkeError('decryption failed');
      }
      seq++;
      return plaintext;
    },
  };
}

/**
 * RFC 9180 §5.1.1 SetupBaseS. `ephemeral` replaces the random ephemeral key
 * only in tests (vectors); production callers pass `random`.
 */
export function setupBaseS(
  recipientPublic: Uint8Array,
  info: Uint8Array,
  random: RandomBytes,
  ephemeral?: Uint8Array,
): { enc: Uint8Array; context: HpkeContext } {
  const secretE = ephemeral ?? random(32);
  if (secretE.length !== 32) throw new HpkeError('random source returned a wrong length');
  const enc = x25519.getPublicKey(secretE);
  const shared = sharedSecret(dh(secretE, recipientPublic), enc, recipientPublic);
  return { enc, context: context(shared, info) };
}

/** RFC 9180 §5.1.1 SetupBaseR. */
export function setupBaseR(
  enc: Uint8Array,
  recipientSecret: Uint8Array,
  info: Uint8Array,
): HpkeContext {
  if (enc.length !== 32) throw new HpkeError('invalid encapsulated key');
  const pkR = x25519.getPublicKey(recipientSecret);
  return context(sharedSecret(dh(recipientSecret, enc), enc, pkR), info);
}

/** RFC 9180 §6.1: single-shot seal. */
export function sealBase(input: {
  recipientPublic: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  random: RandomBytes;
}): { enc: Uint8Array; ciphertext: Uint8Array } {
  const { enc, context: ctx } = setupBaseS(input.recipientPublic, input.info, input.random);
  return { enc, ciphertext: ctx.seal(input.aad, input.plaintext) };
}

/** RFC 9180 §6.1: single-shot open. Throws `HpkeError` on any failure. */
export function openBase(input: {
  enc: Uint8Array;
  recipientSecret: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  return setupBaseR(input.enc, input.recipientSecret, input.info).open(input.aad, input.ciphertext);
}
