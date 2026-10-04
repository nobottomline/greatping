import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { fromBase64Url, toBase64Url } from './bytes';
import type { RandomBytes } from './cpace';

/**
 * Member keys: Ed25519 to sign manifest versions (and, for computers, their
 * content), X25519 to receive encrypted content. Public keys travel as
 * `{ alg, key }` with an unpadded base64url key, so a later rotation to
 * another algorithm (hardware P-256) stays readable by old verifiers, which
 * simply reject what they do not know.
 */
export const SIGN_ALG = 'ed25519';
export const ENC_ALG = 'x25519';

export interface PublicKey {
  alg: string;
  key: string;
}

export interface MemberKeys {
  sign: PublicKey;
  enc: PublicKey;
}

/** Secret halves; never sent anywhere. */
export interface SecretKeys {
  sign: Uint8Array;
  enc: Uint8Array;
}

export interface KeyPairs {
  secret: SecretKeys;
  public: MemberKeys;
}

export function generateKeys(random: RandomBytes): KeyPairs {
  const sign = random(32);
  const enc = random(32);
  if (sign.length !== 32 || enc.length !== 32)
    throw new Error('random source returned a wrong length');
  return { secret: { sign, enc }, public: publicKeysOf({ sign, enc }) };
}

export function publicKeysOf(secret: SecretKeys): MemberKeys {
  return {
    sign: { alg: SIGN_ALG, key: toBase64Url(ed25519.getPublicKey(secret.sign)) },
    enc: { alg: ENC_ALG, key: toBase64Url(x25519.getPublicKey(secret.enc)) },
  };
}

export function signBytes(secret: SecretKeys, message: Uint8Array): string {
  return toBase64Url(ed25519.sign(message, secret.sign));
}

/** Strict RFC 8032 verification; an unknown algorithm or malformed input is `false`. */
export function verifyBytes(key: PublicKey, message: Uint8Array, signature: string): boolean {
  if (key.alg !== SIGN_ALG) return false;
  try {
    return ed25519.verify(fromBase64Url(signature), message, fromBase64Url(key.key), {
      zip215: false,
    });
  } catch {
    return false;
  }
}

/** Whether keys are well formed for their algorithms (32-byte Ed25519 and X25519 keys). */
export function validMemberKeys(keys: MemberKeys): boolean {
  try {
    if (keys.sign.alg !== SIGN_ALG || keys.enc.alg !== ENC_ALG) return false;
    const sign = fromBase64Url(keys.sign.key);
    const enc = fromBase64Url(keys.enc.key);
    return sign.length === 32 && enc.length === 32 && ed25519.utils.isValidPublicKey(sign, false);
  } catch {
    return false;
  }
}
