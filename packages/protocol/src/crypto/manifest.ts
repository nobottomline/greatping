import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, fromBase64Url, lvCat, toBase64Url, utf8 } from './bytes';
import {
  type MemberKeys,
  type PublicKey,
  type SecretKeys,
  signBytes,
  validMemberKeys,
  verifyBytes,
} from './keys';

/**
 * The account manifest: an append-only, versioned list of the account's
 * devices and computers with their public keys. Each version records exactly
 * one change and is signed by a device; `previous` commits to the version
 * before it, so a signed version vouches for the whole history.
 *
 * `verifyNext` is the one implementation of the trust rules for key changes.
 * The Worker runs it before storing a version, the CLI and the app before
 * trusting one. See docs/device-keys.md.
 */

/** Removing an older member needs the signer to have joined this long ago (trust model). */
export const REMOVAL_COOLING_OFF_MS = 72 * 3600 * 1000;
/** How far a version's `createdAt` may be ahead of the verifier's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const TAG = utf8('GreatPing manifest v1');

export type MemberKind = 'device' | 'computer';
export type ManifestOp = 'genesis' | 'add' | 'remove' | 'rotate';

export interface Member extends MemberKeys {
  kind: MemberKind;
  id: string;
  /** `createdAt` of the version that added it. */
  addedAt: number;
  /** The device that added it; null for the genesis device. */
  addedBy: string | null;
}

export interface ManifestBody {
  account: string;
  version: number;
  /** `manifestHash` of the previous version; empty for genesis. */
  previous: string;
  change: { op: ManifestOp; target: string };
  /** Sorted by id. */
  members: Member[];
  /** The signing device. */
  signer: string;
  createdAt: number;
}

export interface Manifest extends ManifestBody {
  signature: string;
}

export type ManifestErrorCode =
  | 'malformed'
  | 'account'
  | 'version'
  | 'previous'
  | 'clock'
  | 'signer'
  | 'signature'
  | 'change'
  | 'cooling_off';

export class ManifestError extends Error {
  constructor(
    readonly code: ManifestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const decimal = (n: number) => utf8(String(n));
const keyBytes = (key: PublicKey) => [utf8(key.alg), utf8(key.key)];

function memberBytes(m: Member): Uint8Array {
  return lvCat(
    utf8(m.kind),
    utf8(m.id),
    ...keyBytes(m.sign),
    ...keyBytes(m.enc),
    decimal(m.addedAt),
    utf8(m.addedBy ?? ''),
  );
}

/** The signed bytes. Members must already be sorted; `signManifest` sorts them. */
export function canonicalManifest(body: ManifestBody): Uint8Array {
  return lvCat(
    TAG,
    utf8(body.account),
    decimal(body.version),
    utf8(body.previous),
    utf8(body.change.op),
    utf8(body.change.target),
    utf8(body.signer),
    decimal(body.createdAt),
    decimal(body.members.length),
    ...body.members.map(memberBytes),
  );
}

/** SHA-256 over the canonical bytes and the signature, base64url. */
export function manifestHash(manifest: Manifest): string {
  return toBase64Url(sha256(lvCat(canonicalManifest(manifest), fromBase64Url(manifest.signature))));
}

const byId = (a: Member, b: Member) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function signManifest(body: ManifestBody, secret: SecretKeys): Manifest {
  const sorted = { ...body, members: [...body.members].sort(byId) };
  return { ...sorted, signature: signBytes(secret, canonicalManifest(sorted)) };
}

// ---------------------------------------------------------------------------
// Building versions
// ---------------------------------------------------------------------------

export function createGenesis(input: {
  account: string;
  device: string;
  keys: MemberKeys;
  secret: SecretKeys;
  createdAt: number;
}): Manifest {
  return signManifest(
    {
      account: input.account,
      version: 1,
      previous: '',
      change: { op: 'genesis', target: input.device },
      members: [
        {
          kind: 'device',
          id: input.device,
          ...input.keys,
          addedAt: input.createdAt,
          addedBy: null,
        },
      ],
      signer: input.device,
      createdAt: input.createdAt,
    },
    input.secret,
  );
}

type Signer = { id: string; secret: SecretKeys };

function next(
  prev: Manifest,
  signer: Signer,
  createdAt: number,
  change: ManifestBody['change'],
  members: Member[],
): Manifest {
  return signManifest(
    {
      account: prev.account,
      version: prev.version + 1,
      previous: manifestHash(prev),
      change,
      members,
      signer: signer.id,
      createdAt: Math.max(createdAt, prev.createdAt),
    },
    signer.secret,
  );
}

export function addMember(
  prev: Manifest,
  signer: Signer,
  member: { kind: MemberKind; id: string } & MemberKeys,
  createdAt: number,
): Manifest {
  const at = Math.max(createdAt, prev.createdAt);
  return next(prev, signer, at, { op: 'add', target: member.id }, [
    ...prev.members,
    { ...member, addedAt: at, addedBy: signer.id },
  ]);
}

export function removeMember(
  prev: Manifest,
  signer: Signer,
  target: string,
  createdAt: number,
): Manifest {
  return next(
    prev,
    signer,
    createdAt,
    { op: 'remove', target },
    prev.members.filter((m) => m.id !== target),
  );
}

/** Replaces the signer's own keys, signed with its current key. */
export function rotateKeys(
  prev: Manifest,
  signer: Signer,
  keys: MemberKeys,
  createdAt: number,
): Manifest {
  return next(
    prev,
    signer,
    createdAt,
    { op: 'rotate', target: signer.id },
    prev.members.map((m) => (m.id === signer.id ? { ...m, ...keys } : m)),
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const isInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isId = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= 64 && /^[\w-]+$/.test(s);

/** Shape checks shared by every version. Throws `malformed`. */
function checkShape(m: Manifest): void {
  const fail = (why: string): never => {
    throw new ManifestError('malformed', why);
  };
  if (typeof m !== 'object' || m === null) fail('not an object');
  if (!isId(m.account)) fail('account');
  if (!isInt(m.version) || m.version < 1) fail('version');
  if (typeof m.previous !== 'string') fail('previous');
  if (!isInt(m.createdAt)) fail('createdAt');
  if (!isId(m.signer)) fail('signer');
  if (typeof m.signature !== 'string') fail('signature');
  const ops: ManifestOp[] = ['genesis', 'add', 'remove', 'rotate'];
  if (!m.change || !ops.includes(m.change.op) || !isId(m.change.target)) fail('change');
  if (!Array.isArray(m.members) || m.members.length === 0) fail('members');
  let last = '';
  for (const member of m.members) {
    if (member.kind !== 'device' && member.kind !== 'computer') fail('member kind');
    if (!isId(member.id) || member.id <= last) fail('members must be sorted and unique');
    last = member.id;
    if (!isInt(member.addedAt)) fail('member addedAt');
    if (member.addedBy !== null && !isId(member.addedBy)) fail('member addedBy');
    if (!validMemberKeys(member)) fail('member keys');
  }
  if (!m.members.some((member) => member.kind === 'device')) fail('no device');
}

function checkSignature(m: Manifest, key: PublicKey): void {
  if (!verifyBytes(key, canonicalManifest(m), m.signature))
    throw new ManifestError('signature', 'signature does not verify');
}

function checkClock(m: Manifest, now: number): void {
  if (m.createdAt > now + MAX_CLOCK_SKEW_MS)
    throw new ManifestError('clock', 'version is dated in the future');
}

const sameMember = (a: Member, b: Member) => equalBytes(memberBytes(a), memberBytes(b));

export function verifyGenesis(m: Manifest, account: string, now: number): void {
  checkShape(m);
  if (m.account !== account) throw new ManifestError('account', 'another account');
  if (m.version !== 1 || m.previous !== '' || m.change.op !== 'genesis')
    throw new ManifestError('version', 'not a genesis version');
  const [device] = m.members;
  if (
    m.members.length !== 1 ||
    !device ||
    device.kind !== 'device' ||
    device.id !== m.signer ||
    m.change.target !== m.signer ||
    device.addedBy !== null ||
    device.addedAt !== m.createdAt
  )
    throw new ManifestError('change', 'genesis must hold only its signing device');
  checkClock(m, now);
  checkSignature(m, device.sign);
}

/** Checks one transition. Throws `ManifestError`; returns nothing on success. */
export function verifyNext(prev: Manifest, m: Manifest, now: number): void {
  checkShape(m);
  if (m.account !== prev.account) throw new ManifestError('account', 'another account');
  if (m.version !== prev.version + 1) throw new ManifestError('version', 'not the next version');
  if (m.previous !== manifestHash(prev))
    throw new ManifestError('previous', 'does not follow the previous version');
  if (m.createdAt < prev.createdAt)
    throw new ManifestError('clock', 'dated before the previous version');
  checkClock(m, now);
  const before = new Map(prev.members.map((member) => [member.id, member]));
  const after = new Map(m.members.map((member) => [member.id, member]));
  const signer = before.get(m.signer);
  if (signer?.kind !== 'device')
    throw new ManifestError('signer', 'signer is not a device of the previous version');
  checkSignature(m, signer.sign);

  const { op, target } = m.change;
  const unchangedExcept = (id: string) =>
    [...before.values()].every(
      (member) =>
        member.id === id ||
        (after.has(member.id) && sameMember(member, after.get(member.id) as Member)),
    );
  const changeError = (why: string) => new ManifestError('change', why);

  if (op === 'add') {
    const added = after.get(target);
    if (before.has(target) || !added || after.size !== before.size + 1)
      throw changeError('add must add exactly its target');
    if (added.addedAt !== m.createdAt || added.addedBy !== m.signer)
      throw changeError('a new member is added by the signer at the version time');
    if (!unchangedExcept(target)) throw changeError('add changed other members');
    return;
  }
  if (op === 'remove') {
    const removed = before.get(target);
    if (!removed || after.has(target) || after.size !== before.size - 1)
      throw changeError('remove must remove exactly its target');
    if (!unchangedExcept(target)) throw changeError('remove changed other members');
    const allowed =
      target === m.signer ||
      removed.addedAt > signer.addedAt ||
      m.createdAt - signer.addedAt >= REMOVAL_COOLING_OFF_MS;
    if (!allowed)
      throw new ManifestError(
        'cooling_off',
        'a device can remove an older member only 72 hours after joining',
      );
    return;
  }
  if (op === 'rotate') {
    const old = before.get(target);
    const rotated = after.get(target);
    if (target !== m.signer || !old || !rotated || after.size !== before.size)
      throw changeError('a member rotates only its own keys');
    if (
      rotated.kind !== old.kind ||
      rotated.addedAt !== old.addedAt ||
      rotated.addedBy !== old.addedBy ||
      sameMember(rotated, old)
    )
      throw changeError('rotate changes only the keys');
    if (!unchangedExcept(target)) throw changeError('rotate changed other members');
    return;
  }
  throw changeError('genesis can only be the first version');
}

/**
 * Verifies a chain from genesis and returns its latest version. `trusted`, if
 * given, is a version already verified (for example a pinned one): the chain
 * must contain it unchanged, so a server cannot fork the history.
 */
export function verifyChain(
  chain: Manifest[],
  account: string,
  now: number,
  trusted?: Manifest,
): Manifest {
  const [first, ...rest] = chain;
  if (!first) throw new ManifestError('malformed', 'empty chain');
  verifyGenesis(first, account, now);
  let prev = first;
  for (const version of rest) {
    verifyNext(prev, version, now);
    prev = version;
  }
  if (trusted) {
    const pinned = chain[trusted.version - 1];
    if (!pinned || manifestHash(pinned) !== manifestHash(trusted))
      throw new ManifestError('previous', 'the chain does not contain the trusted version');
  }
  return prev;
}

/** The member with this id, if present. */
export function memberOf(manifest: ManifestBody, id: string): Member | undefined {
  return manifest.members.find((member) => member.id === id);
}
