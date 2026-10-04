import { describe, expect, it } from 'vitest';
import {
  addMember,
  canonicalManifest,
  createGenesis,
  generateKeys,
  type KeyPairs,
  type Manifest,
  ManifestError,
  manifestHash,
  REMOVAL_COOLING_OFF_MS,
  removeMember,
  rotateKeys,
  signManifest,
  toHex,
  verifyChain,
  verifyGenesis,
  verifyNext,
} from '../src/crypto';

/** Deterministic keys, so signatures and hashes are reproducible vectors. */
function keys(seed: number): KeyPairs {
  let counter = seed * 1000;
  return generateKeys((n) => Uint8Array.from({ length: n }, () => counter++ & 0xff));
}

const HOUR = 3600 * 1000;
const T0 = 1_790_000_000_000;
const NOW = T0 + 10 * 24 * HOUR;
const phone = { id: 'dev_phone', ...keys(1) };
const tablet = { id: 'dev_tablet', ...keys(2) };
const mac = { id: 'mc_mac', ...keys(3) };
const as = (m: { id: string; secret: KeyPairs['secret'] }) => ({ id: m.id, secret: m.secret });
const device = (m: typeof phone) => ({ kind: 'device' as const, id: m.id, ...m.public });
const computer = (m: typeof mac) => ({ kind: 'computer' as const, id: m.id, ...m.public });

function genesis(): Manifest {
  return createGenesis({
    account: 'acc_1',
    device: phone.id,
    keys: phone.public,
    secret: phone.secret,
    createdAt: T0,
  });
}

/** The error code a verification throws, or undefined when it passes. */
function failure(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof ManifestError) return error.code;
    throw error;
  }
}

describe('manifest encoding', () => {
  it('is stable across runtimes (vector)', () => {
    const g = genesis();
    expect(g.members[0]?.sign.key).toBe('3o8Unzm948mZcdxhQd2mr8Ghhd4Ur3xS9wL_Wqr1Gug');
    expect(g.members[0]?.enc.key).toBe('arcRgiJO46ju8aWQ3Eca3m2rhv3u8DiQfLoacn1CcE8');
    expect(toHex(canonicalManifest(g))).toBe(
      '15477265617450696e67206d616e6966657374207631056163635f310131000767656e65736973096465765f70686f6e65096465765f70686f6e650d313739303030303030303030300131870106646576696365096465765f70686f6e6507656432353531392b336f38556e7a6d3934386d5a636478685164326d72384768686434557233785339774c5f57717231477567067832353531392b6172635267694a4f34366a753861575133456361336d32726876337538446951664c6f61636e31436345380d3137393030303030303030303000',
    );
    expect(g.signature).toBe(
      't84Qg1Tr5mWExZYaP13OfrwJAgyEaA46RARkevIzwCktM2pAoeQTHRVf4PQiyIubKTXZJ7t6rxMVs8tF1t_5Cw',
    );
    expect(manifestHash(g)).toBe('-QmH_TKkceZtnPGnKzfzdcGghXSEXcPazfKmVdqJxAU');
  });
});

describe('genesis', () => {
  it('holds exactly its signing device', () => {
    expect(failure(() => verifyGenesis(genesis(), 'acc_1', NOW))).toBeUndefined();
    expect(failure(() => verifyGenesis(genesis(), 'acc_2', NOW))).toBe('account');
    const two = signManifest(
      {
        ...genesis(),
        members: [...genesis().members, { ...device(tablet), addedAt: T0, addedBy: null }],
      },
      phone.secret,
    );
    expect(failure(() => verifyGenesis(two, 'acc_1', NOW))).toBe('change');
    // Signed by someone else's key while naming the phone.
    const forged = signManifest(genesis(), tablet.secret);
    expect(failure(() => verifyGenesis(forged, 'acc_1', NOW))).toBe('signature');
  });
});

describe('transitions', () => {
  const g = genesis();
  const withMac = addMember(g, as(phone), computer(mac), T0 + HOUR);
  const withTablet = addMember(withMac, as(phone), device(tablet), T0 + 2 * HOUR);

  it('add members signed by a device and verify as a chain', () => {
    expect(failure(() => verifyNext(g, withMac, NOW))).toBeUndefined();
    const latest = verifyChain([g, withMac, withTablet], 'acc_1', NOW);
    expect(latest.members.map((m) => m.id)).toEqual(['dev_phone', 'dev_tablet', 'mc_mac']);
    expect(latest.members.find((m) => m.id === 'dev_tablet')?.addedBy).toBe('dev_phone');
  });

  it('refuse a key swapped after signing', () => {
    const swapped = {
      ...withMac,
      members: withMac.members.map((m) => (m.id === mac.id ? { ...m, ...tablet.public } : m)),
    };
    expect(failure(() => verifyNext(g, swapped, NOW))).toBe('signature');
  });

  it('refuse versions a server could invent or reorder', () => {
    // A computer never signs; nor does a key outside the manifest.
    const byComputer = signManifest({ ...withTablet, signer: mac.id }, mac.secret);
    expect(failure(() => verifyNext(withMac, byComputer, NOW))).toBe('signer');
    const byStranger = signManifest({ ...withTablet, signer: 'dev_ghost' }, keys(9).secret);
    expect(failure(() => verifyNext(withMac, byStranger, NOW))).toBe('signer');
    // Skipping, replaying or forking history.
    expect(failure(() => verifyNext(g, withTablet, NOW))).toBe('version');
    const fork = addMember(g, as(phone), device(tablet), T0 + HOUR);
    expect(failure(() => verifyNext(withMac, { ...fork, version: 3 }, NOW))).toBe('previous');
    expect(failure(() => verifyChain([g, fork], 'acc_1', NOW, withMac))).toBe('previous');
    // Dated in the future beyond the allowed skew.
    const future = addMember(withMac, as(phone), device(tablet), NOW + HOUR);
    expect(failure(() => verifyNext(withMac, future, NOW))).toBe('clock');
  });

  it('refuse a change that does more than it says', () => {
    // "add" that also drops the computer.
    const sneaky = signManifest(
      {
        ...withTablet,
        members: withTablet.members.filter((m) => m.id !== mac.id),
      },
      phone.secret,
    );
    expect(failure(() => verifyNext(withMac, sneaky, NOW))).toBe('change');
    // A new member backdated to look senior.
    const backdated = signManifest(
      {
        ...withTablet,
        members: withTablet.members.map((m) =>
          m.id === tablet.id ? { ...m, addedAt: T0 - HOUR } : m,
        ),
      },
      phone.secret,
    );
    expect(failure(() => verifyNext(withMac, backdated, NOW))).toBe('change');
  });

  it('apply the 72-hour rule to removals', () => {
    const early = T0 + 3 * HOUR;
    // The new tablet cannot remove the older phone or computer yet…
    const kickPhone = removeMember(withTablet, as(tablet), phone.id, early);
    expect(failure(() => verifyNext(withTablet, kickPhone, NOW))).toBe('cooling_off');
    const kickMac = removeMember(withTablet, as(tablet), mac.id, early);
    expect(failure(() => verifyNext(withTablet, kickMac, NOW))).toBe('cooling_off');
    // …but the phone can remove the tablet at once, and the tablet itself.
    const byPhone = removeMember(withTablet, as(phone), tablet.id, early);
    expect(failure(() => verifyNext(withTablet, byPhone, NOW))).toBeUndefined();
    const leave = removeMember(withTablet, as(tablet), tablet.id, early);
    expect(failure(() => verifyNext(withTablet, leave, NOW))).toBeUndefined();
    // After 72 hours the tablet is senior enough.
    const later = T0 + 2 * HOUR + REMOVAL_COOLING_OFF_MS;
    const kickLater = removeMember(withTablet, as(tablet), phone.id, later);
    expect(failure(() => verifyNext(withTablet, kickLater, NOW))).toBeUndefined();
    // The last device cannot be removed by a version; leaving closes the account instead.
    const alone = removeMember(withMac, as(phone), phone.id, early);
    expect(failure(() => verifyNext(withMac, alone, NOW))).toBe('malformed');
  });

  it('let a member rotate only its own keys, signed with the old key', () => {
    const fresh = keys(7);
    const rotated = rotateKeys(withTablet, as(tablet), fresh.public, T0 + 4 * HOUR);
    expect(failure(() => verifyNext(withTablet, rotated, NOW))).toBeUndefined();
    // Signed with the new key: a stolen-key takeover cannot pass as a rotation.
    const selfSigned = rotateKeys(
      withTablet,
      { id: tablet.id, secret: fresh.secret },
      fresh.public,
      T0 + 4 * HOUR,
    );
    expect(failure(() => verifyNext(withTablet, selfSigned, NOW))).toBe('signature');
    const other = signManifest(
      {
        ...rotated,
        change: { op: 'rotate', target: phone.id },
        members: withTablet.members.map((m) => (m.id === phone.id ? { ...m, ...fresh.public } : m)),
      },
      tablet.secret,
    );
    expect(failure(() => verifyNext(withTablet, other, NOW))).toBe('change');
  });

  it('reject malformed members and unknown algorithms', () => {
    const odd = signManifest(
      {
        ...withMac,
        members: withMac.members.map((m) =>
          m.id === mac.id ? { ...m, sign: { alg: 'rsa', key: m.sign.key } } : m,
        ),
      },
      phone.secret,
    );
    expect(failure(() => verifyNext(g, odd, NOW))).toBe('malformed');
    const unsorted = { ...withMac, members: [...withMac.members].reverse() };
    expect(failure(() => verifyNext(g, unsorted, NOW))).toBe('malformed');
  });
});
