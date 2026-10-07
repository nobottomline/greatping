import { describe, expect, it } from 'vitest';
import {
  deriveKeyPair,
  fromHex,
  HpkeError,
  openBase,
  sealBase,
  setupBaseR,
  setupBaseS,
  toHex,
} from '../src/crypto';
import rfc from './vectors/rfc9180-a2-base.json';

const v = rfc.vector;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('HPKE base mode, RFC 9180 A.2.1', () => {
  it('derives the vector key pairs', () => {
    const e = deriveKeyPair(fromHex(v.ikmE));
    const r = deriveKeyPair(fromHex(v.ikmR));
    expect(toHex(e.secret)).toBe(v.skEm);
    expect(toHex(e.public)).toBe(v.pkEm);
    expect(toHex(r.secret)).toBe(v.skRm);
    expect(toHex(r.public)).toBe(v.pkRm);
  });

  it('seals every vector message in sequence', () => {
    const { enc, context } = setupBaseS(fromHex(v.pkRm), fromHex(v.info), random, fromHex(v.skEm));
    expect(toHex(enc)).toBe(v.enc);
    for (const m of v.encryptions)
      expect(toHex(context.seal(fromHex(m.aad), fromHex(m.pt)))).toBe(m.ct);
  });

  it('opens every vector message in sequence', () => {
    const context = setupBaseR(fromHex(v.enc), fromHex(v.skRm), fromHex(v.info));
    for (const m of v.encryptions)
      expect(toHex(context.open(fromHex(m.aad), fromHex(m.ct)))).toBe(m.pt);
  });
});

describe('single-shot seal and open', () => {
  const recipient = deriveKeyPair(random(32));
  const sealed = () =>
    sealBase({
      recipientPublic: recipient.public,
      info: new Uint8Array([1]),
      aad: new Uint8Array([2]),
      plaintext: new Uint8Array([3, 4, 5]),
      random,
    });

  it('round-trips', () => {
    const { enc, ciphertext } = sealed();
    const plaintext = openBase({
      enc,
      recipientSecret: recipient.secret,
      info: new Uint8Array([1]),
      aad: new Uint8Array([2]),
      ciphertext,
    });
    expect([...plaintext]).toEqual([3, 4, 5]);
  });

  it('refuses another recipient, info, aad or a changed byte', () => {
    const { enc, ciphertext } = sealed();
    const base = {
      enc,
      recipientSecret: recipient.secret,
      info: new Uint8Array([1]),
      aad: new Uint8Array([2]),
      ciphertext,
    };
    const flipped = ciphertext.slice();
    flipped[0] = (flipped[0] as number) ^ 1;
    for (const change of [
      { recipientSecret: deriveKeyPair(random(32)).secret },
      { info: new Uint8Array([9]) },
      { aad: new Uint8Array([9]) },
      { ciphertext: flipped },
    ])
      expect(() => openBase({ ...base, ...change })).toThrow(HpkeError);
  });

  it('rejects a small-order public key (all-zero shared secret)', () => {
    expect(() =>
      sealBase({
        recipientPublic: new Uint8Array(32),
        info: new Uint8Array(),
        aad: new Uint8Array(),
        plaintext: new Uint8Array(),
        random,
      }),
    ).toThrow(HpkeError);
  });
});
