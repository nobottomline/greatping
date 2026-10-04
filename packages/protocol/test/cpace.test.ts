import { describe, expect, it } from 'vitest';
import {
  CpaceError,
  calculateGenerator,
  confirmationTags,
  cpaceIsk,
  cpaceShare,
  equalBytes,
  fromBase64Url,
  fromHex,
  generatorString,
  leb128,
  lvCat,
  prependLen,
  scalarMult,
  scalarMultVfy,
  toBase64Url,
  toHex,
  transcriptIr,
  utf8,
} from '../src/crypto';

// draft-irtf-cfrg-cpace-21, appendix B.3 (ristretto255, SHA-512).
const V = {
  prs: utf8('Password'),
  ci: fromHex('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: fromHex('7e4b4791d6a8ef019b936c79fb7f2c57'),
  genStr:
    '11435061636552697374726574746f3235350850617373776f726464' +
    '00'.repeat(100) +
    '180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57',
  g: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ada: utf8('ADa'),
  ya: 'da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08',
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  adb: utf8('ADb'),
  yb: 'd2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d',
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  K: '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f',
  transcript:
    '20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7' +
    'e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462',
  isk:
    'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd' +
    '2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
};

const scalarLE = (hex: string) =>
  fromHex(hex).reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

describe('CPace ristretto255 vectors', () => {
  const g = calculateGenerator(V.prs, V.ci, V.sid);
  const transcript = {
    sid: V.sid,
    ya: fromHex(V.Ya),
    ada: V.ada,
    yb: fromHex(V.Yb),
    adb: V.adb,
  };

  it('derives the generator', () => {
    expect(toHex(generatorString(V.prs, V.ci, V.sid))).toBe(V.genStr);
    expect(toHex(g.toBytes())).toBe(V.g);
  });

  it('computes both shares and the same secret point', () => {
    expect(toHex(scalarMult(scalarLE(V.ya), g))).toBe(V.Ya);
    expect(toHex(scalarMult(scalarLE(V.yb), g))).toBe(V.Yb);
    expect(toHex(scalarMultVfy(scalarLE(V.ya), fromHex(V.Yb)))).toBe(V.K);
    expect(toHex(scalarMultVfy(scalarLE(V.yb), fromHex(V.Ya)))).toBe(V.K);
  });

  it('derives the session key on both sides', () => {
    expect(toHex(transcriptIr(transcript.ya, V.ada, transcript.yb, V.adb))).toBe(V.transcript);
    expect(toHex(cpaceIsk(scalarLE(V.ya), 'initiator', transcript))).toBe(V.isk);
    expect(toHex(cpaceIsk(scalarLE(V.yb), 'responder', transcript))).toBe(V.isk);
  });

  it('maps valid inputs and rejects invalid ones (B.3.10, B.3.11)', () => {
    const s = scalarLE('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05');
    const x = fromHex('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
    expect(toHex(scalarMultVfy(s, x))).toBe(
      '7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e',
    );
    const invalid = fromHex('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
    const identity = new Uint8Array(32);
    expect(equalBytes(scalarMultVfy(s, invalid), identity)).toBe(true);
    expect(equalBytes(scalarMultVfy(s, identity), identity)).toBe(true);
    expect(() => cpaceIsk(s, 'initiator', { ...transcript, yb: invalid })).toThrow(CpaceError);
    expect(() => cpaceIsk(s, 'responder', { ...transcript, ya: identity })).toThrow(CpaceError);
  });
});

describe('CPace runs', () => {
  const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  const run = (prsA: string, prsB: string) => {
    const sid = utf8('pairing-1');
    const a = cpaceShare({ prs: utf8(prsA), ci: utf8('ci'), sid }, random);
    const b = cpaceShare({ prs: utf8(prsB), ci: utf8('ci'), sid }, random);
    const t = { sid, ya: a.share, ada: utf8('A'), yb: b.share, adb: utf8('B') };
    const iskA = cpaceIsk(a.scalar, 'initiator', t);
    const iskB = cpaceIsk(b.scalar, 'responder', t);
    return { iskA, iskB, tagsA: confirmationTags(iskA, t), tagsB: confirmationTags(iskB, t) };
  };

  it('agrees with the same secret and confirms both ways', () => {
    const { iskA, iskB, tagsA, tagsB } = run('K7QM', 'K7QM');
    expect(equalBytes(iskA, iskB)).toBe(true);
    expect(equalBytes(tagsA.responder, tagsB.responder)).toBe(true);
    expect(equalBytes(tagsA.initiator, tagsB.initiator)).toBe(true);
    expect(equalBytes(tagsA.initiator, tagsA.responder)).toBe(false);
  });

  it('fails confirmation with a different secret', () => {
    const { iskA, iskB, tagsA, tagsB } = run('K7QM', 'K7QN');
    expect(equalBytes(iskA, iskB)).toBe(false);
    expect(equalBytes(tagsA.responder, tagsB.responder)).toBe(false);
  });
});

describe('encodings', () => {
  it('encodes LEB128 and length-value lists (A.1)', () => {
    expect(toHex(leb128(0))).toBe('00');
    expect(toHex(leb128(127))).toBe('7f');
    expect(toHex(leb128(128))).toBe('8001');
    expect(toHex(leb128(16384))).toBe('808001');
    expect(toHex(prependLen(new Uint8Array(0)))).toBe('00');
    expect(toHex(prependLen(utf8('1234')))).toBe('0431323334');
    const range = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);
    expect(toHex(prependLen(range(127)))).toBe(`7f${toHex(range(127))}`);
    expect(toHex(prependLen(range(128)))).toBe(`8001${toHex(range(128))}`);
    expect(toHex(lvCat(utf8('1234'), utf8('5'), new Uint8Array(0), utf8('678')))).toBe(
      '043132333401350003363738',
    );
  });

  it('round-trips canonical base64url only', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      expect(toHex(fromBase64Url(toBase64Url(bytes)))).toBe(toHex(bytes));
    }
    expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
    expect(() => fromBase64Url('-_9')).toThrow();
    expect(() => fromBase64Url('a+b')).toThrow();
    expect(() => fromBase64Url('A')).toThrow();
  });
});
