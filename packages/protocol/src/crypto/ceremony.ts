import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { USER_CODE_ALPHABET } from '../constants';
import { equalBytes, fromBase64Url, lvCat, toBase64Url, utf8 } from './bytes';
import {
  type CpaceTranscript,
  confirmationTags,
  cpaceIsk,
  cpaceShare,
  type RandomBytes,
} from './cpace';
import type { MemberKeys, PublicKey } from './keys';
import { type Manifest, type MemberKind, manifestHash, verifyChain } from './manifest';

/**
 * Pairing a computer and linking a device as a CPace ceremony, version 2
 * (docs/pairing-v2.md).
 *
 * The code shown on the initiator's screen, `ABCD-EFGH`, is a lookup (`ABCD`,
 * chosen by the server, which uses it to find the session) and a secret
 * (`EFGH`, chosen by the initiator and never sent to the server). The secret is
 * the CPace password.
 *
 * The approving device (responder) signs nothing before it has verified the
 * initiator's tag `Ta`, which proves that whoever holds the identity bound in
 * `ADa` (member id, name, platform, keys) knows the secret. Only then does it
 * sign the manifest version adding that member, with an approval `A` over the
 * version's hash. The initiator checks `A` and the version and answers with
 * `D`, which tells the device the initiator accepted exactly that version.
 *
 * Initiator: the computer (pairing) or the new device (linking).
 * Responder: the device that approves.
 *
 * Single use is enforced here, by both sides, not by the server: scalars live
 * only in these objects; the initiator answers one responder message and the
 * responder signs off one approval.
 */

/** Each half of a code; the alphabet has 32 symbols, so a byte maps without bias. */
export const CODE_HALF_LENGTH = 4;

/** The ceremony version clients announce when they start a session. */
export const CEREMONY_VERSION = 2;

export type CeremonyKind = 'pair' | 'link';

const CHANNEL: Record<CeremonyKind, Uint8Array> = {
  pair: utf8('GreatPing pair v2'),
  link: utf8('GreatPing link v2'),
};

const APPROVE_LABEL = utf8('GreatPing approve v2');
const DONE_LABEL = utf8('GreatPing done v2');

/** The member kind a ceremony adds. */
export const memberKindOf = (kind: CeremonyKind): MemberKind =>
  kind === 'pair' ? 'computer' : 'device';

/** Four random symbols: the half of the code the server never sees. */
export function newCodeHalf(random: RandomBytes): string {
  const bytes = random(CODE_HALF_LENGTH);
  if (bytes.length !== CODE_HALF_LENGTH) throw new Error('random source returned a wrong length');
  return Array.from(bytes, (b) => USER_CODE_ALPHABET[b & 31]).join('');
}

/** `ABCD-EFGH` from its halves. */
export function joinUserCode(lookup: string, secret: string): string {
  return `${lookup}-${secret}`;
}

/**
 * The halves of a typed or scanned code, or null if it is not one. Accepts any
 * case and separators, like `normalizeUserCode`.
 */
export function splitUserCode(raw: string): { lookup: string; secret: string } | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_HALF_LENGTH * 2) return null;
  if ([...code].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
  return { lookup: code.slice(0, CODE_HALF_LENGTH), secret: code.slice(CODE_HALF_LENGTH) };
}

/** Who the initiator is. Every field is bound into the run. */
export interface InitiatorIdentity {
  /** The id the server reserved for it, which the manifest version adds. */
  memberId: string;
  /** Its name and platform as it sent them, so the approval card shows them authentically. */
  name: string;
  platform: string;
  keys: MemberKeys;
}

/** Who answered: the approving device and its account, from its own verified state. */
export interface ResponderIdentity {
  accountId: string;
  deviceId: string;
}

const keyParts = (key: PublicKey) => [utf8(key.alg), utf8(key.key)];

/** `ADa`. */
export function initiatorData(kind: CeremonyKind, who: InitiatorIdentity): Uint8Array {
  return lvCat(
    utf8('initiator'),
    utf8(kind),
    utf8(who.memberId),
    utf8(who.name),
    utf8(who.platform),
    ...keyParts(who.keys.sign),
    ...keyParts(who.keys.enc),
  );
}

/** `ADb`. */
export function responderData(kind: CeremonyKind, who: ResponderIdentity): Uint8Array {
  return lvCat(utf8('responder'), utf8(kind), utf8(who.accountId), utf8(who.deviceId));
}

export class CeremonyError extends Error {}

const inputs = (kind: CeremonyKind, session: string, secret: string) => ({
  prs: utf8(secret),
  ci: CHANNEL[kind],
  sid: utf8(session),
});

function transcript(
  kind: CeremonyKind,
  session: string,
  initiatorShare: string,
  initiator: InitiatorIdentity,
  responderShare: string,
  responder: ResponderIdentity,
): CpaceTranscript {
  try {
    return {
      sid: utf8(session),
      ya: fromBase64Url(initiatorShare),
      ada: initiatorData(kind, initiator),
      yb: fromBase64Url(responderShare),
      adb: responderData(kind, responder),
    };
  } catch {
    throw new CeremonyError('malformed ceremony message');
  }
}

/** The keys a run derives from its ISK. `macKey` is CPace's own (section 10.4). */
interface Schedule {
  initiatorTag: Uint8Array;
  approve: Uint8Array;
  done: Uint8Array;
}

function schedule(isk: Uint8Array, t: CpaceTranscript): Schedule {
  return {
    initiatorTag: confirmationTags(isk, t).initiator,
    approve: hkdf(sha512, isk, t.sid, APPROVE_LABEL, 64),
    done: hkdf(sha512, isk, t.sid, DONE_LABEL, 64),
  };
}

/** The bytes `A` and `D` authenticate, each under its own key. */
function approvalMessage(
  kind: CeremonyKind,
  session: string,
  memberId: string,
  hash: string,
): Uint8Array {
  return lvCat(utf8(kind), utf8(session), utf8(memberId), utf8(hash));
}

function equalTag(expected: Uint8Array, tag: string): boolean {
  try {
    return equalBytes(expected, fromBase64Url(tag));
  } catch {
    return false;
  }
}

function deriveIsk(scalar: bigint, role: 'initiator' | 'responder', t: CpaceTranscript) {
  try {
    return cpaceIsk(scalar, role, t);
  } catch {
    throw new CeremonyError('the code did not match');
  }
}

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

/** The responder's message as the server relays it to the initiator. */
export interface CeremonyResponse {
  share: string;
  accountId: string;
  deviceId: string;
}

/** The responder's approval as the server relays it to the initiator. */
export interface CeremonyApproval {
  manifestHash: string;
  tag: string;
}

/**
 * The initiator's side. Create it with `startCeremony`, send `share` with the
 * start call, then `answer` the responder's message (M3) and `finish` with the
 * approval (M5). Lives only in memory; a restarted initiator starts over.
 */
export class CeremonyInitiator {
  readonly kind: CeremonyKind;
  readonly session: string;
  /** `Ya`. */
  readonly share: string;
  readonly name: string;
  readonly platform: string;
  readonly keys: MemberKeys;
  #scalar: bigint | null;
  #answered: {
    message: Uint8Array;
    tag: string;
    identity: InitiatorIdentity;
    responder: ResponderIdentity;
    keys: Schedule;
  } | null = null;
  #ended = false;

  constructor(input: {
    kind: CeremonyKind;
    session: string;
    secret: string;
    name: string;
    platform: string;
    keys: MemberKeys;
    random: RandomBytes;
  }) {
    const { scalar, share } = cpaceShare(
      inputs(input.kind, input.session, input.secret),
      input.random,
    );
    this.kind = input.kind;
    this.session = input.session;
    this.share = toBase64Url(share);
    this.name = input.name;
    this.platform = input.platform;
    this.keys = input.keys;
    this.#scalar = scalar;
  }

  #end(message: string): never {
    this.#ended = true;
    this.#scalar = null;
    this.#answered = null;
    throw new CeremonyError(message);
  }

  /**
   * `Ta` for the first responder message this initiator sees (M3). The same
   * message again, after a lost response, returns the same tag; any other
   * message ends the ceremony, so nobody gets a second guess at the secret.
   */
  answer(memberId: string, response: CeremonyResponse): string {
    if (this.#ended) throw new CeremonyError('this ceremony has ended');
    const identity: InitiatorIdentity = {
      memberId,
      name: this.name,
      platform: this.platform,
      keys: this.keys,
    };
    const responder = { accountId: response.accountId, deviceId: response.deviceId };
    let t: CpaceTranscript;
    try {
      t = transcript(this.kind, this.session, this.share, identity, response.share, responder);
    } catch {
      return this.#end('malformed ceremony message');
    }
    const message = lvCat(t.ada, t.yb, t.adb);
    if (this.#answered) {
      if (equalBytes(this.#answered.message, message)) return this.#answered.tag;
      return this.#end('another answer arrived for this code');
    }
    const scalar = this.#scalar;
    if (scalar === null) return this.#end('this ceremony has ended');
    let isk: Uint8Array;
    try {
      isk = deriveIsk(scalar, 'initiator', t);
    } catch {
      return this.#end('the code did not match');
    }
    this.#scalar = null;
    const keys = schedule(isk, t);
    const tag = toBase64Url(keys.initiatorTag);
    this.#answered = { message, tag, identity, responder, keys };
    return tag;
  }

  /**
   * Checks the approval (M4 relayed) against the account's chain and returns
   * `D` for the responder, with the latest verified manifest to pin. Accepts
   * only when `A` verifies, the chain verifies from genesis, the approved
   * version is in it and adds exactly this initiator, signed by the answering
   * device, and the latest version still holds this initiator unchanged.
   * Any failure ends the ceremony.
   */
  finish(input: { approval: CeremonyApproval; manifests: Manifest[]; now: number }): {
    tag: string;
    manifest: Manifest;
  } {
    if (this.#ended || !this.#answered) throw new CeremonyError('this ceremony has not answered');
    const { identity, responder, keys } = this.#answered;
    const message = approvalMessage(
      this.kind,
      this.session,
      identity.memberId,
      input.approval.manifestHash,
    );
    if (!equalTag(hmac(sha512, keys.approve, message), input.approval.tag))
      return this.#end('the approval did not match');
    let latest: Manifest;
    try {
      latest = verifyApprovedAddition({
        manifests: input.manifests,
        responder,
        member: { kind: memberKindOf(this.kind), id: identity.memberId, keys: identity.keys },
        manifestHash: input.approval.manifestHash,
        now: input.now,
      });
    } catch {
      return this.#end('the account does not hold this approval');
    }
    const tag = toBase64Url(hmac(sha512, keys.done, message));
    this.#ended = true;
    this.#answered = null;
    return { tag, manifest: latest };
  }
}

export const startCeremony = (input: ConstructorParameters<typeof CeremonyInitiator>[0]) =>
  new CeremonyInitiator(input);

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

/**
 * The approving device's side. Create it with `respondToCeremony` once the
 * user entered the code, send `share` (M2), `confirm` the initiator's tag
 * (M3) and only then show the approval card. After the user approves, sign
 * the version and send it with `approval` (M4); keep `expectedDone` to check
 * the initiator's final tag (M5). Lives only in memory.
 */
export class CeremonyResponder {
  readonly kind: CeremonyKind;
  readonly session: string;
  readonly initiator: InitiatorIdentity;
  readonly responder: ResponderIdentity;
  /** `Yb`. */
  readonly share: string;
  #keys: Schedule | null;
  #confirmed = false;
  #approved: string | null = null;

  constructor(input: {
    kind: CeremonyKind;
    session: string;
    secret: string;
    initiatorShare: string;
    initiator: InitiatorIdentity;
    responder: ResponderIdentity;
    random: RandomBytes;
  }) {
    const { scalar, share } = cpaceShare(
      inputs(input.kind, input.session, input.secret),
      input.random,
    );
    this.kind = input.kind;
    this.session = input.session;
    this.initiator = input.initiator;
    this.responder = input.responder;
    this.share = toBase64Url(share);
    // A malformed or invalid initiator share leaves nothing to confirm: every tag fails.
    let keys: Schedule | null = null;
    try {
      const t = transcript(
        input.kind,
        input.session,
        input.initiatorShare,
        input.initiator,
        this.share,
        input.responder,
      );
      keys = schedule(deriveIsk(scalar, 'responder', t), t);
    } catch {
      keys = null;
    }
    this.#keys = keys;
  }

  /**
   * Whether the initiator's tag proves it knows the code and holds the
   * identity this responder saw. A wrong tag ends the ceremony for good.
   */
  confirm(tag: string): boolean {
    const keys = this.#keys;
    if (!keys) return false;
    if (this.#confirmed) return equalTag(keys.initiatorTag, tag);
    if (!equalTag(keys.initiatorTag, tag)) {
      this.#keys = null;
      return false;
    }
    this.#confirmed = true;
    return true;
  }

  #message(hash: string) {
    return approvalMessage(this.kind, this.session, this.initiator.memberId, hash);
  }

  /**
   * `A` for the signed version adding the initiator (M4). Only after
   * `confirm`, and for one version only: a ceremony approves once.
   */
  approval(manifest: Manifest): { manifestHash: string; tag: string } {
    const keys = this.#keys;
    if (!keys || !this.#confirmed) throw new CeremonyError('the code was not confirmed');
    const hash = manifestHash(manifest);
    if (this.#approved !== null && this.#approved !== hash)
      throw new CeremonyError('this ceremony already approved another version');
    const added = manifest.members.find((m) => m.id === this.initiator.memberId);
    if (
      manifest.account !== this.responder.accountId ||
      manifest.signer !== this.responder.deviceId ||
      manifest.change.op !== 'add' ||
      manifest.change.target !== this.initiator.memberId ||
      !added ||
      added.kind !== memberKindOf(this.kind) ||
      !sameKeys(added, this.initiator.keys)
    )
      throw new CeremonyError('the version does not add the confirmed initiator');
    this.#approved = hash;
    return {
      manifestHash: hash,
      tag: toBase64Url(hmac(sha512, keys.approve, this.#message(hash))),
    };
  }

  /** The `D` the initiator sends once it accepted the approved version. */
  expectedDone(manifestHashOfApproved: string): string {
    const keys = this.#keys;
    if (!keys || !this.#confirmed || this.#approved !== manifestHashOfApproved)
      throw new CeremonyError('nothing was approved');
    return toBase64Url(hmac(sha512, keys.done, this.#message(manifestHashOfApproved)));
  }
}

export const respondToCeremony = (input: ConstructorParameters<typeof CeremonyResponder>[0]) =>
  new CeremonyResponder(input);

/** Whether a posted final tag matches the one a responder expected. */
export function doneConfirmed(expected: string, tag: string): boolean {
  try {
    return equalTag(fromBase64Url(expected), tag);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The approved version
// ---------------------------------------------------------------------------

const sameKeys = (a: MemberKeys, b: MemberKeys) =>
  a.sign.alg === b.sign.alg &&
  a.sign.key === b.sign.key &&
  a.enc.alg === b.enc.alg &&
  a.enc.key === b.enc.key;

/**
 * The initiator's check of the version it was approved by: the chain verifies
 * from genesis for the responder's account; the version with `manifestHash`
 * is in it, adds exactly this member with these keys and was signed by the
 * responding device; and the latest version still holds the member unchanged
 * (later versions by other devices are fine). Returns the latest version.
 */
export function verifyApprovedAddition(input: {
  manifests: Manifest[];
  responder: ResponderIdentity;
  member: { kind: MemberKind; id: string; keys: MemberKeys };
  manifestHash: string;
  now: number;
}): Manifest {
  const latest = verifyChain(input.manifests, input.responder.accountId, input.now);
  const approved = input.manifests.find((m) => manifestHash(m) === input.manifestHash);
  const added = approved?.members.find((m) => m.id === input.member.id);
  const current = latest.members.find((m) => m.id === input.member.id);
  if (
    !approved ||
    approved.signer !== input.responder.deviceId ||
    approved.change.op !== 'add' ||
    approved.change.target !== input.member.id ||
    added?.kind !== input.member.kind ||
    !sameKeys(added, input.member.keys) ||
    current?.kind !== input.member.kind ||
    !sameKeys(current, input.member.keys)
  )
    throw new CeremonyError('the manifest does not hold this approval');
  return latest;
}
