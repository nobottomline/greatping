import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  CeremonyError,
  type CeremonyInitiator,
  type CeremonyKind,
  type CeremonyResponder,
  createGenesis,
  doneConfirmed,
  generateKeys,
  initiatorData,
  joinUserCode,
  type KeyPairs,
  type Manifest,
  manifestHash,
  newCodeHalf,
  removeMember,
  responderData,
  respondToCeremony,
  splitUserCode,
  startCeremony,
  toBase64Url,
  toHex,
  utf8,
  verifyApprovedAddition,
} from '../src/crypto';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const T0 = 1_790_000_000_000;

/** A reproducible random source, for vectors. */
function seeded(seed: string) {
  let counter = 0;
  let pool = new Uint8Array(0);
  return (n: number) => {
    while (pool.length < n) {
      const block = sha512(utf8(`${seed}/${counter++}`));
      const next = new Uint8Array(pool.length + block.length);
      next.set(pool);
      next.set(block, pool.length);
      pool = next;
    }
    const out = pool.slice(0, n);
    pool = pool.slice(n);
    return out;
  };
}

interface World {
  kind: CeremonyKind;
  phone: KeyPairs;
  genesis: Manifest;
  initiator: CeremonyInitiator;
  initiatorKeys: KeyPairs;
  secret: string;
  memberId: string;
}

function world(kind: CeremonyKind = 'pair', rng = random): World {
  const phone = generateKeys(rng);
  const genesis = createGenesis({
    account: 'acc_1',
    device: 'dev_phone',
    keys: phone.public,
    secret: phone.secret,
    createdAt: T0,
  });
  const initiatorKeys = generateKeys(rng);
  // The initiator draws the secret half and its session id; the server only
  // ever sees the lookup.
  const secret = newCodeHalf(rng);
  const initiator = startCeremony({
    kind,
    session: toBase64Url(rng(16)),
    secret,
    name: kind === 'pair' ? 'MacBook Pro' : 'iPad',
    platform: kind === 'pair' ? 'darwin' : 'ios',
    keys: initiatorKeys.public,
    random: rng,
  });
  return {
    kind,
    phone,
    genesis,
    initiator,
    initiatorKeys,
    secret,
    memberId: kind === 'pair' ? 'mc_mac' : 'dev_ipad',
  };
}

/** What the server shows the approving device in the preview; tests tamper with it. */
function preview(w: World) {
  return {
    session: w.initiator.session,
    share: w.initiator.share,
    identity: {
      memberId: w.memberId,
      name: w.initiator.name,
      platform: w.initiator.platform,
      keys: w.initiator.keys,
    },
  };
}

const me = { accountId: 'acc_1', deviceId: 'dev_phone' };

function respond(
  w: World,
  over: Partial<ReturnType<typeof preview>> & { secret?: string } = {},
  rng = random,
): CeremonyResponder {
  const p = { ...preview(w), ...over };
  return respondToCeremony({
    kind: w.kind,
    session: p.session,
    secret: over.secret ?? w.secret,
    initiatorShare: p.share,
    initiator: p.identity,
    responder: me,
    random: rng,
  });
}

/** The version the approving device signs after confirming. */
function addition(w: World, keys = w.initiator.keys, id = w.memberId, at = T0 + 1000) {
  return addMember(
    w.genesis,
    { id: 'dev_phone', secret: w.phone.secret },
    { kind: w.kind === 'pair' ? 'computer' : 'device', id, ...keys },
    at,
  );
}

/** The whole honest run; returns every message for tests to replay or alter. */
function run(w: World) {
  const responder = respond(w);
  const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
  expect(responder.confirm(ta)).toBe(true);
  const version = addition(w);
  const approval = responder.approval(version);
  const done = w.initiator.finish({ approval, manifests: [w.genesis, version], now: T0 + 2000 });
  return { responder, ta, version, approval, done };
}

describe('pairing ceremony v2', () => {
  it('confirms the initiator before anything is signed, then the approval, then completion', () => {
    for (const kind of ['pair', 'link'] as const) {
      const w = world(kind);
      const { responder, approval, done } = run(w);
      expect(done.manifest.version).toBe(2);
      expect(doneConfirmed(responder.expectedDone(approval.manifestHash), done.tag)).toBe(true);
    }
  });

  it('refuses before the approval card when the secret half is mistyped', () => {
    const w = world();
    const typo = w.secret === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const responder = respond(w, { secret: typo });
    const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
    expect(responder.confirm(ta)).toBe(false);
    // Nothing can be approved, so the device never sends a signed version.
    expect(() => responder.approval(addition(w))).toThrow(CeremonyError);
  });

  it('refuses when the server swaps what the preview shows', () => {
    const evil = generateKeys(random).public;
    type Preview = ReturnType<typeof preview>;
    const swaps: Array<(p: Preview) => Preview> = [
      (p) => ({ ...p, identity: { ...p.identity, keys: evil } }),
      (p) => ({ ...p, identity: { ...p.identity, memberId: 'mc_other' } }),
      (p) => ({ ...p, identity: { ...p.identity, name: 'Work MacBook' } }),
      (p) => ({ ...p, identity: { ...p.identity, platform: 'linux' } }),
    ];
    for (const swap of swaps) {
      const w = world();
      const responder = respond(w, swap(preview(w)));
      // The real initiator answers with what it actually holds.
      const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
      expect(responder.confirm(ta)).toBe(false);
    }
    // The server's own session in place of the computer's: it can answer,
    // but it does not know the secret the user read off the real screen.
    const w = world();
    const forged = startCeremony({
      kind: 'pair',
      session: w.initiator.session,
      secret: w.secret === 'ZZZZ' ? 'YYYY' : 'ZZZZ',
      name: w.initiator.name,
      platform: w.initiator.platform,
      keys: evil,
      random,
    });
    const responder = respond(w, {
      share: forged.share,
      identity: { ...preview(w).identity, keys: evil },
    });
    const forgedTa = forged.answer(w.memberId, { share: responder.share, ...me });
    expect(responder.confirm(forgedTa)).toBe(false);
    expect(() => responder.approval(addition(w, evil))).toThrow(CeremonyError);
  });

  it('refuses when the server relays another account or device to the initiator', () => {
    for (const relayed of [
      { accountId: 'acc_evil', deviceId: 'dev_phone' },
      { accountId: 'acc_1', deviceId: 'dev_evil' },
    ]) {
      const w = world();
      const responder = respond(w);
      const ta = w.initiator.answer(w.memberId, { share: responder.share, ...relayed });
      expect(responder.confirm(ta)).toBe(false);
    }
  });

  it('answers one responder message only, and repeats the same tag for a retransmit', () => {
    const w = world();
    const responder = respond(w);
    const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
    expect(w.initiator.answer(w.memberId, { share: responder.share, ...me })).toBe(ta);
    // A second share is a second guess at the secret: the ceremony ends.
    const other = respond(w);
    expect(() => w.initiator.answer(w.memberId, { share: other.share, ...me })).toThrow(
      CeremonyError,
    );
    expect(() => w.initiator.answer(w.memberId, { share: responder.share, ...me })).toThrow(
      CeremonyError,
    );
  });

  it('ends on the same share with another account, device or member id', () => {
    for (const change of [
      { accountId: 'acc_2' },
      { deviceId: 'dev_other' },
      { memberId: 'mc_other' },
    ]) {
      const w = world();
      const responder = respond(w);
      w.initiator.answer(w.memberId, { share: responder.share, ...me });
      expect(() =>
        w.initiator.answer(change.memberId ?? w.memberId, {
          share: responder.share,
          ...me,
          ...change,
        }),
      ).toThrow(CeremonyError);
    }
  });

  it('a responder that saw a wrong tag stays refused', () => {
    const w = world();
    const responder = respond(w);
    const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
    expect(responder.confirm(toBase64Url(new Uint8Array(64)))).toBe(false);
    expect(responder.confirm(ta)).toBe(false);
    expect(responder.confirm('not base64!')).toBe(false);
  });

  it('approves only a version adding the confirmed member with its keys, once', () => {
    const w = world();
    const responder = respond(w);
    expect(() => responder.approval(addition(w))).toThrow(CeremonyError); // not confirmed yet
    responder.confirm(w.initiator.answer(w.memberId, { share: responder.share, ...me }));
    expect(() => responder.approval(addition(w, generateKeys(random).public))).toThrow(
      CeremonyError,
    );
    expect(() => responder.approval(addition(w, w.initiator.keys, 'mc_other'))).toThrow(
      CeremonyError,
    );
    const version = addition(w);
    const approval = responder.approval(version);
    expect(responder.approval(version)).toEqual(approval); // a retransmit
    expect(() => responder.approval(addition(w, w.initiator.keys, w.memberId, T0 + 5000))).toThrow(
      CeremonyError,
    );
  });

  it('the initiator refuses an approval from another run, or another tag in its place', () => {
    const other = run(world());
    const confirmed = () => {
      const w = world();
      const responder = respond(w);
      const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
      responder.confirm(ta);
      const version = addition(w);
      return { w, ta, version, approval: responder.approval(version) };
    };
    const attempts = [
      (c: ReturnType<typeof confirmed>) => ({ ...c.approval, tag: other.approval.tag }),
      (c: ReturnType<typeof confirmed>) => ({ ...c.approval, tag: c.ta }),
      (c: ReturnType<typeof confirmed>) => ({
        ...c.approval,
        manifestHash: manifestHash(c.w.genesis),
      }),
    ];
    for (const attempt of attempts) {
      const c = confirmed();
      expect(() =>
        c.w.initiator.finish({
          approval: attempt(c),
          manifests: [c.w.genesis, c.version],
          now: T0 + 2000,
        }),
      ).toThrow(CeremonyError);
    }
  });

  it('the initiator ends after a refused approval', () => {
    const w = world();
    const responder = respond(w);
    responder.confirm(w.initiator.answer(w.memberId, { share: responder.share, ...me }));
    const version = addition(w);
    const approval = responder.approval(version);
    expect(() =>
      w.initiator.finish({
        approval: { manifestHash: approval.manifestHash, tag: toBase64Url(new Uint8Array(64)) },
        manifests: [w.genesis, version],
        now: T0 + 2000,
      }),
    ).toThrow(CeremonyError);
    expect(() =>
      w.initiator.finish({ approval, manifests: [w.genesis, version], now: T0 + 2000 }),
    ).toThrow(CeremonyError);
  });

  it('the initiator needs the approved version in the chain and itself still in the latest', () => {
    const w = world();
    const responder = respond(w);
    responder.confirm(w.initiator.answer(w.memberId, { share: responder.share, ...me }));
    const version = addition(w);
    const approval = responder.approval(version);
    // A server that withholds the version: the hash is not in the chain.
    expect(() => w.initiator.finish({ approval, manifests: [w.genesis], now: T0 + 2000 })).toThrow(
      CeremonyError,
    );
  });

  it('accepts later versions by other devices, but not its own removal', () => {
    const w = world();
    const responder = respond(w);
    responder.confirm(w.initiator.answer(w.memberId, { share: responder.share, ...me }));
    const version = addition(w);
    const approval = responder.approval(version);
    const tablet = generateKeys(random);
    const later = addMember(
      version,
      { id: 'dev_phone', secret: w.phone.secret },
      { kind: 'device', id: 'dev_tablet', ...tablet.public },
      T0 + 1500,
    );
    const member = { kind: 'computer' as const, id: w.memberId, keys: w.initiator.keys };
    const hash = approval.manifestHash;
    expect(
      verifyApprovedAddition({
        manifests: [w.genesis, version, later],
        responder: me,
        member,
        manifestHash: hash,
        now: T0 + 2000,
      }).version,
    ).toBe(3);
    const removed = removeMember(
      later,
      { id: 'dev_phone', secret: w.phone.secret },
      w.memberId,
      T0 + 1600,
    );
    expect(() =>
      verifyApprovedAddition({
        manifests: [w.genesis, version, later, removed],
        responder: me,
        member,
        manifestHash: hash,
        now: T0 + 2000,
      }),
    ).toThrow(CeremonyError);
    // The approved version must be signed by the device that answered.
    expect(() =>
      verifyApprovedAddition({
        manifests: [w.genesis, version],
        responder: { ...me, deviceId: 'dev_tablet' },
        member,
        manifestHash: hash,
        now: T0 + 2000,
      }),
    ).toThrow(CeremonyError);
    // And it must be the version that adds this member, not any version.
    expect(() =>
      verifyApprovedAddition({
        manifests: [w.genesis, version, later],
        responder: me,
        member,
        manifestHash: manifestHash(later),
        now: T0 + 2000,
      }),
    ).toThrow(CeremonyError);
    expect(() =>
      w.initiator.finish({
        approval,
        manifests: [w.genesis, version, later, removed],
        now: T0 + 2000,
      }),
    ).toThrow(CeremonyError);
  });

  it('a final tag from another run does not confirm', () => {
    const a = world();
    const b = world();
    const ra = run(a);
    const rb = run(b);
    expect(doneConfirmed(ra.responder.expectedDone(ra.approval.manifestHash), rb.done.tag)).toBe(
      false,
    );
    // Neither does `A` or `Ta` posted as the final tag.
    const expected = ra.responder.expectedDone(ra.approval.manifestHash);
    expect(doneConfirmed(expected, ra.approval.tag)).toBe(false);
    expect(doneConfirmed(expected, ra.ta)).toBe(false);
  });

  it('a pairing answer never completes a link with the same secret and session', () => {
    const w = world('pair');
    const link = startCeremony({
      kind: 'link',
      session: w.initiator.session,
      secret: w.secret,
      name: w.initiator.name,
      platform: w.initiator.platform,
      keys: w.initiator.keys,
      random,
    });
    const responder = respond(w);
    const ta = link.answer(w.memberId, { share: responder.share, ...me });
    expect(responder.confirm(ta)).toBe(false);
  });

  it('is stable across runtimes (vector)', () => {
    const w = world('pair', seeded('greatping pairing v2'));
    const rng = seeded('greatping pairing v2 responder');
    const responder = respond(w, {}, rng);
    const ta = w.initiator.answer(w.memberId, { share: responder.share, ...me });
    expect(responder.confirm(ta)).toBe(true);
    const version = addition(w);
    const approval = responder.approval(version);
    const done = w.initiator.finish({ approval, manifests: [w.genesis, version], now: T0 + 2000 });
    expect(w.secret).toBe('URKN');
    expect(toHex(initiatorData('pair', preview(w).identity))).toMatchInlineSnapshot(
      `"09696e69746961746f720470616972066d635f6d61630b4d6163426f6f6b2050726f0664617277696e07656432353531392b43527943726b4c4446496d6d6a7148647248563846526d4b78444e477a784d72306f737157746a4654316f067832353531392b4534616e6847467a714d36744756633950516e67747a73396c75724d5f6c75685436383255576568745234"`,
    );
    expect(toHex(responderData('link', me))).toBe(
      '09726573706f6e646572046c696e6b056163635f31096465765f70686f6e65',
    );
    expect({
      ya: w.initiator.share,
      yb: responder.share,
      ta,
      a: approval.tag,
      d: done.tag,
    }).toMatchInlineSnapshot(`
      {
        "a": "gxRBzpumGS-yECvYrINN1sTqpElpcifTQ54hGSmcOtS1ogj2Nh6_osKVaPlEVA9kHgGfD5fm1r3ddMxnblDItQ",
        "d": "f4O5q6yaOuyHy9hzt6jQCVRMAkPUB4Kl9fXS1pu7bEMxfAIiFbCHzAglSWk7RApcRt1bNglw_EJGpfL5_pSrFg",
        "ta": "YD9G2CFf2vmshobisnpxQOWhBDiwUJ7P-PSWn9ySS6sopCU5cR1qf-w9MSNgXQObW4rnzsFRLY4BbgAg0WU2UA",
        "ya": "YvWhRRjXTMY0bS2Z78xSaPjZ7_uw3tpKSX-87BUf5wU",
        "yb": "zChJu69Kbo_hxBtDOgOfb-L6vJZawGY64KgrKnwNcmg",
      }
    `);
  });
});

describe('user codes', () => {
  it('split into lookup and secret, in any case and with separators', () => {
    expect(splitUserCode('k7qm-x2zp')).toEqual({ lookup: 'K7QM', secret: 'X2ZP' });
    expect(splitUserCode(' K7QM X2ZP ')).toEqual({ lookup: 'K7QM', secret: 'X2ZP' });
    expect(splitUserCode('K7QM')).toBeNull();
    expect(splitUserCode('K7QM-X2Z0')).toBeNull(); // 0 is not in the alphabet
    expect(joinUserCode('K7QM', 'X2ZP')).toBe('K7QM-X2ZP');
  });

  it('draws secrets from the alphabet only', () => {
    for (let i = 0; i < 200; i++) expect(newCodeHalf(random)).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
  });
});
