import type { CeremonyResponse, ManifestsResponse } from '@greatping/protocol';
import {
  finishCeremony,
  generateKeys,
  type InitiatorState,
  type Manifest,
  type MemberKeys,
  manifestHash,
  toBase64Url,
  verifyChain,
  verifyNext,
} from '@greatping/protocol/crypto';
import { api } from './api';
import { type Config, isPaired, saveConfig } from './config';

/**
 * This computer's keys and its view of the account manifest
 * (docs/device-keys.md). The computer never signs manifest versions; it only
 * verifies them, so a server cannot make it trust a key no device of the
 * account vouched for.
 */

export const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

export function newMachineKeys(): { secret: NonNullable<Config['keys']>; public: MemberKeys } {
  const keys = generateKeys(randomBytes);
  return {
    secret: { sign: toBase64Url(keys.secret.sign), enc: toBase64Url(keys.secret.enc) },
    public: keys.public,
  };
}

/**
 * Checks the approving device's answer at the end of pairing and returns the
 * computer's confirmation tag with the verified manifest. Throws when anything
 * does not match: the secret half, the keys, the chain or this computer's
 * place in it.
 */
export function verifyPairing(input: {
  state: InitiatorState;
  ceremony: CeremonyResponse;
  manifests: Manifest[];
  accountId: string;
  machineId: string;
  keys: MemberKeys;
}): { tag: string; manifest: Manifest } {
  const { tag } = finishCeremony(input.state, input.ceremony);
  const latest = verifyChain(input.manifests, input.accountId, Date.now());
  const vouched = input.manifests.find((m) => manifestHash(m) === input.ceremony.manifestHash);
  const me = latest.members.find((m) => m.id === input.machineId);
  if (
    !vouched ||
    vouched.signer !== input.ceremony.device ||
    !me ||
    me.kind !== 'computer' ||
    me.sign.key !== input.keys.sign.key ||
    me.enc.key !== input.keys.enc.key
  )
    throw new Error('the manifest does not hold this computer');
  return { tag, manifest: latest };
}

export type ManifestState =
  | { status: 'none' }
  | { status: 'current'; version: number }
  | { status: 'removed'; version: number }
  | { status: 'invalid'; version: number; reason: string };

/**
 * Follows the account manifest from the pinned version: every newer version
 * must verify against the one before. Saves the newest verified version.
 * Best effort; a network failure keeps the pinned one.
 */
export async function followManifest(config: Config, signal?: AbortSignal): Promise<ManifestState> {
  if (!isPaired(config) || !config.manifest) return { status: 'none' };
  const pinned = config.manifest;
  let newer: Manifest[];
  try {
    const res = await api<ManifestsResponse>(config, 'GET', `/manifests?after=${pinned.version}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
    });
    newer = res.manifests as Manifest[];
  } catch {
    return stateOf(config.machineId, pinned);
  }
  let latest = pinned;
  for (const version of newer) {
    try {
      verifyNext(latest, version, Date.now());
    } catch (error) {
      return {
        status: 'invalid',
        version: latest.version,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    latest = version;
  }
  if (latest !== pinned) saveConfig({ ...config, manifest: latest });
  return stateOf(config.machineId, latest);
}

function stateOf(machineId: string, manifest: Manifest): ManifestState {
  return manifest.members.some((m) => m.id === machineId)
    ? { status: 'current', version: manifest.version }
    : { status: 'removed', version: manifest.version };
}
