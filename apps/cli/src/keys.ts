import type { ManifestsResponse } from '@greatping/protocol';
import {
  generateKeys,
  type Manifest,
  type MemberKeys,
  toBase64Url,
  verifyNext,
} from '@greatping/protocol/crypto';
import { api } from './api';
import { type Config, isPaired, loadConfig, saveConfig } from './config';

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

/** Replays a saved final confirmation; only an acknowledgement clears it. */
export async function confirmPendingCeremony(config: Config, signal?: AbortSignal): Promise<void> {
  const tag = config.pendingCeremonyTag;
  if (!tag || !isPaired(config)) return;
  await api(config, 'POST', '/machine/me/ceremony', {
    body: { tag },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  signal?.throwIfAborted();
  const { pendingCeremonyTag, ...saved } = loadConfig();
  if (
    saved.machineId !== config.machineId ||
    saved.machineToken !== config.machineToken ||
    pendingCeremonyTag !== tag
  )
    throw new Error('Local pairing changed while confirming. Run greatping login again.');
  saveConfig(saved);
  delete config.pendingCeremonyTag;
}
