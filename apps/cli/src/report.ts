import type { MachineMeResponse } from '@greatping/protocol';
import { api } from './api';
import { type Config, isPaired } from './config';
import { describeMachine } from './describe';
import { rememberProjectLabels } from './identity';
import { hostIntegrations } from './integrations';
import { VERSION } from './version';

export function currentDescription() {
  return describeMachine({ cliVersion: VERSION, hosts: hostIntegrations() });
}

/**
 * Refreshes the description shown on devices and the computer's settings that
 * hooks apply locally (project labels). Best effort and silent.
 */
export async function reportMachine(config: Config): Promise<void> {
  if (!isPaired(config)) return;
  try {
    await api(config, 'PATCH', '/machine/me', {
      body: currentDescription(),
      signal: AbortSignal.timeout(3000),
    });
    const me = await api<MachineMeResponse>(config, 'GET', '/machine/me', {
      signal: AbortSignal.timeout(3000),
    });
    rememberProjectLabels(me.machine.projectLabels);
  } catch {
    // The description is informational; it must never fail a command.
  }
}
