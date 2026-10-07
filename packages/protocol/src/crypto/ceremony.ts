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

/**
 * Pairing a computer and linking a device as a CPace ceremony.
 *
 * The code shown on the initiator's screen, `ABCD-EFGH`, is a lookup (`ABCD`,
 * chosen by the server, which uses it to find the session) and a secret
 * (`EFGH`, chosen by the initiator and never sent to the server). The secret is
 * the CPace password; the initiator's keys and the approving device's new
 * manifest version are bound into the run, so a relay that swaps any key, or
 * anyone without the secret, makes the confirmation tags fail.
 *
 * Initiator: the computer (pairing) or the new device (linking).
 * Responder: the device that approves.
 */

/** Each half of a code; the alphabet has 32 symbols, so a byte maps without bias. */
export const CODE_HALF_LENGTH = 4;

export type CeremonyKind = 'pair' | 'link';

const CHANNEL: Record<CeremonyKind, Uint8Array> = {
  pair: utf8('GreatPing pair v1'),
  link: utf8('GreatPing link v1'),
};

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

const keyParts = (key: PublicKey) => [utf8(key.alg), utf8(key.key)];

/** `ADa`: the initiator's public keys. */
export function initiatorData(keys: MemberKeys): Uint8Array {
  return lvCat(utf8('initiator'), ...keyParts(keys.sign), ...keyParts(keys.enc));
}

/** `ADb`: the approving device and the manifest version it signed for this ceremony. */
export function responderData(device: string, manifestHash: string): Uint8Array {
  return lvCat(utf8('responder'), utf8(device), utf8(manifestHash));
}

export class CeremonyError extends Error {}

function transcript(
  sessionId: string,
  initiatorShare: string,
  initiatorKeys: MemberKeys,
  responderShare: string,
  device: string,
  manifestHash: string,
): CpaceTranscript {
  try {
    return {
      sid: utf8(sessionId),
      ya: fromBase64Url(initiatorShare),
      ada: initiatorData(initiatorKeys),
      yb: fromBase64Url(responderShare),
      adb: responderData(device, manifestHash),
    };
  } catch {
    throw new CeremonyError('malformed ceremony message');
  }
}

const inputs = (kind: CeremonyKind, sessionId: string, secret: string) => ({
  prs: utf8(secret),
  ci: CHANNEL[kind],
  sid: utf8(sessionId),
});

/** What the initiator keeps between starting and finishing. Never sent. */
export interface InitiatorState {
  kind: CeremonyKind;
  sessionId: string;
  secret: string;
  /** Hex of the CPace scalar, so the state can be stored as JSON. */
  scalar: string;
  share: string;
  keys: MemberKeys;
}

/**
 * The initiator's first message. `sessionId` is the pairing or link id the
 * server returned with the lookup.
 */
export function startCeremony(input: {
  kind: CeremonyKind;
  sessionId: string;
  secret: string;
  keys: MemberKeys;
  random: RandomBytes;
}): InitiatorState {
  const { scalar, share } = cpaceShare(
    inputs(input.kind, input.sessionId, input.secret),
    input.random,
  );
  return {
    kind: input.kind,
    sessionId: input.sessionId,
    secret: input.secret,
    scalar: scalar.toString(16),
    share: toBase64Url(share),
    keys: input.keys,
  };
}

/**
 * The responder's answer, computed when the user approves: its share and its
 * confirmation tag, plus the tag it expects back from the initiator.
 */
export function respondToCeremony(input: {
  kind: CeremonyKind;
  sessionId: string;
  secret: string;
  initiatorShare: string;
  initiatorKeys: MemberKeys;
  device: string;
  manifestHash: string;
  random: RandomBytes;
}): { share: string; tag: string; expectedInitiatorTag: string } {
  const { scalar, share } = cpaceShare(
    inputs(input.kind, input.sessionId, input.secret),
    input.random,
  );
  const t = transcript(
    input.sessionId,
    input.initiatorShare,
    input.initiatorKeys,
    toBase64Url(share),
    input.device,
    input.manifestHash,
  );
  const tags = confirmationTags(cpaceIsk(scalar, 'responder', t), t);
  return {
    share: toBase64Url(share),
    tag: toBase64Url(tags.responder),
    expectedInitiatorTag: toBase64Url(tags.initiator),
  };
}

/**
 * The initiator checks the responder's tag and returns its own. Throws
 * `CeremonyError` when the tag does not match: a wrong secret, or a relay that
 * changed something in between.
 */
export function finishCeremony(
  state: InitiatorState,
  response: { share: string; device: string; manifestHash: string; tag: string },
): { tag: string } {
  const t = transcript(
    state.sessionId,
    state.share,
    state.keys,
    response.share,
    response.device,
    response.manifestHash,
  );
  let tags: { initiator: Uint8Array; responder: Uint8Array };
  try {
    tags = confirmationTags(cpaceIsk(BigInt(`0x${state.scalar}`), 'initiator', t), t);
  } catch {
    throw new CeremonyError('the code did not match');
  }
  if (!equalTag(tags.responder, response.tag)) throw new CeremonyError('the code did not match');
  return { tag: toBase64Url(tags.initiator) };
}

/** Whether the initiator's tag is the expected one (responder side). */
export function initiatorConfirmed(expected: string, tag: string): boolean {
  return equalTag(fromBase64Url(expected), tag);
}

function equalTag(expected: Uint8Array, tag: string): boolean {
  try {
    return equalBytes(expected, fromBase64Url(tag));
  } catch {
    return false;
  }
}
