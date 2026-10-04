import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concat, equalBytes, lvCat, prependLen, utf8 } from './bytes';

/**
 * CPace (draft-irtf-cfrg-cpace-21) with ristretto255 and SHA-512, in the
 * initiator-responder setting, plus the explicit key confirmation of its
 * section 10.4. Checked against the draft's appendix B.3 vectors.
 *
 * A short shared secret (the PRS, here the part of a pairing code the server
 * never sees) lets two parties derive a strong shared key over an untrusted
 * relay. Someone without the secret, the relay included, gets one guess per
 * run, and a wrong guess makes the run fail on both sides.
 */

const Point = ristretto255.Point;

/** The part of a ristretto255 point this module uses. */
export interface RistrettoPoint {
  multiply(scalar: bigint): RistrettoPoint;
  toBytes(): Uint8Array;
  is0(): boolean;
}

/** `G.DSI` of the ristretto255 group. */
export const CPACE_DSI = utf8('CPaceRistretto255');
const DSI_ISK = utf8('CPaceRistretto255_ISK');
/** SHA-512 input block size, `H.s_in_bytes`. */
const S_IN_BYTES = 128;
/** Encoding of the neutral element, `G.I`. */
const IDENTITY = new Uint8Array(32);

/**
 * A cryptographically secure random source, always passed explicitly:
 * `crypto.getRandomValues` in the Worker and Node, `expo-crypto` in the app.
 */
export type RandomBytes = (length: number) => Uint8Array;

/** `generator_string(DSI, PRS, CI, sid, s_in_bytes)`. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, S_IN_BYTES - prependLen(prs).length - prependLen(CPACE_DSI).length - 1);
  return lvCat(CPACE_DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** `G.calculate_generator(H, PRS, CI, sid)`: a decoded point. */
export function calculateGenerator(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): RistrettoPoint {
  const hash = sha512(generatorString(prs, ci, sid));
  return ristretto255_hasher.deriveToCurve?.(hash) as RistrettoPoint;
}

/**
 * `G.sample_scalar()` as the draft recommends: 32 random bytes with the bits
 * above 252 cleared, read little-endian. Zero is redrawn (probability 2^-252).
 */
export function sampleScalar(random: RandomBytes): bigint {
  for (;;) {
    const bytes = random(32);
    if (bytes.length !== 32) throw new Error('random source returned a wrong length');
    bytes[31] = (bytes[31] as number) & 0x0f;
    let value = 0n;
    for (let i = 31; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] as number);
    if (value !== 0n) return value;
  }
}

/** `G.scalar_mult(y, g)`: an encoded point. */
export function scalarMult(scalar: bigint, generator: RistrettoPoint): Uint8Array {
  return generator.multiply(scalar).toBytes();
}

/** `G.scalar_mult_vfy(y, X)`: `G.I` when X does not decode or the result is neutral. */
export function scalarMultVfy(scalar: bigint, encoded: Uint8Array): Uint8Array {
  let point: RistrettoPoint;
  try {
    point = Point.fromBytes(encoded) as RistrettoPoint;
  } catch {
    return IDENTITY;
  }
  const result = point.is0() ? point : point.multiply(scalar);
  return result.is0() ? IDENTITY : result.toBytes();
}

/** `transcript_ir(Ya, ADa, Yb, ADb)`. */
export function transcriptIr(
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array {
  return concat(lvCat(ya, ada), lvCat(yb, adb));
}

export interface CpaceInputs {
  /** The low-entropy shared secret. */
  prs: Uint8Array;
  /** Channel identifier; both sides must agree on it. */
  ci: Uint8Array;
  /** Public, unique session identifier known to both sides beforehand. */
  sid: Uint8Array;
}

export interface CpaceShare {
  /** Secret scalar; keep it only until the session key is derived. */
  scalar: bigint;
  /** Public share sent to the other side (`Ya` or `Yb`). */
  share: Uint8Array;
}

/** One side's secret scalar and public share. */
export function cpaceShare(inputs: CpaceInputs, random: RandomBytes): CpaceShare {
  const scalar = sampleScalar(random);
  return {
    scalar,
    share: scalarMult(scalar, calculateGenerator(inputs.prs, inputs.ci, inputs.sid)),
  };
}

export interface CpaceTranscript {
  sid: Uint8Array;
  /** The initiator's share and associated data. */
  ya: Uint8Array;
  ada: Uint8Array;
  /** The responder's share and associated data. */
  yb: Uint8Array;
  adb: Uint8Array;
}

export class CpaceError extends Error {}

/**
 * The intermediate session key. `scalar` is this side's; the peer's share is
 * taken from the transcript. Throws when the peer's share is invalid.
 */
export function cpaceIsk(
  scalar: bigint,
  role: 'initiator' | 'responder',
  t: CpaceTranscript,
): Uint8Array {
  const peer = role === 'initiator' ? t.yb : t.ya;
  const k = scalarMultVfy(scalar, peer);
  if (equalBytes(k, IDENTITY)) throw new CpaceError('invalid CPace share');
  return sha512(concat(lvCat(DSI_ISK, t.sid, k), transcriptIr(t.ya, t.ada, t.yb, t.adb)));
}

/**
 * Explicit key confirmation (section 10.4): each side proves it holds the
 * session key with a tag over the message it sent. `macKey` is
 * `H("CPaceMac" || sid || ISK)`, the tags HMAC-SHA-512.
 */
export function confirmationTags(
  isk: Uint8Array,
  t: CpaceTranscript,
): { initiator: Uint8Array; responder: Uint8Array } {
  const macKey = sha512(concat(utf8('CPaceMac'), t.sid, isk));
  return {
    initiator: hmac(sha512, macKey, lvCat(t.ya, t.ada)),
    responder: hmac(sha512, macKey, lvCat(t.yb, t.adb)),
  };
}
