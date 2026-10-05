import type { MachineMeResponse } from '@greatping/protocol';
import { api } from './api';
import { type Config, isPaired } from './config';
import { describeMachine } from './describe';
import { rememberProjectLabels } from './identity';
import { hostIntegrations } from './integrations';
import { followManifest } from './keys';
import { withProgress } from './progress';
import { VERSION } from './version';

export function currentDescription() {
  return describeMachine({ cliVersion: VERSION, hosts: hostIntegrations() });
}

/**
 * Refreshes the description shown on devices and the computer's settings that
 * hooks apply locally (project labels). Best effort and silent.
 */
export async function reportMachine(config: Config, signal?: AbortSignal): Promise<void> {
  if (!isPaired(config)) return;
  try {
    // Report the manifest version this computer verified, so devices notice a
    // server that stopped showing it their changes.
    signal?.throwIfAborted();
    const manifest = await followManifest(config, signal);
    signal?.throwIfAborted();
    await api(config, 'PATCH', '/machine/me', {
      body: {
        ...currentDescription(),
        ...(manifest.status === 'current' ? { manifestVersion: manifest.version } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
    });
    const me = await api<MachineMeResponse>(config, 'GET', '/machine/me', {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
    });
    rememberProjectLabels(me.machine.projectLabels);
  } catch {
    // The description is informational; it must never fail a command.
  }
}

/** Explicit CLI flows show the best-effort refresh; background hooks remain silent. */
export async function reportMachineWithProgress(config: Config): Promise<void> {
  if (!isPaired(config)) return;
  await withProgress(
    'Syncing computer settings with GreatPing',
    (signal) => reportMachine(config, signal),
    {
      interrupted:
        'Synchronization interrupted. Local settings were kept; run greatping status to refresh.',
    },
  );
}
