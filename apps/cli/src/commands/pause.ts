import { LIMITS, type PauseMachineResponse } from '@greatping/protocol';
import { api } from '../api';
import { isPaired, loadConfig } from '../config';
import { clock, parseDuration } from '../duration';
import { command, muted, ui } from '../ui';
import { UsageError } from './usage';

function requirePaired() {
  const config = loadConfig();
  if (!isPaired(config)) {
    throw new UsageError(
      null,
      'This computer is not paired.',
      `Run ${command('greatping login')} first.`,
    );
  }
  return config;
}

/**
 * Pauses this computer's alerts on every device. Requests still reach the
 * app's inbox; nothing is pushed until the pause ends or `greatping resume`.
 */
export async function pause(duration: string | undefined) {
  const seconds = parseDuration(duration ?? '1h');
  if (seconds === null) {
    throw new UsageError(
      'pause',
      `Invalid duration "${duration}". Use a value like 30m, 2h or 1d.`,
    );
  }
  if (seconds < 60 || seconds > LIMITS.pauseMaxSec) {
    throw new UsageError('pause', 'Pause for at least a minute and at most 7 days.');
  }
  const config = requirePaired();
  const res = await api<PauseMachineResponse>(config, 'PUT', '/machine/me/pause', {
    body: { until: Date.now() + seconds * 1000 },
  });
  ui.success(`Alerts from this computer are paused until ${clock(res.alertsPausedUntil ?? 0)}.`);
  ui.next(
    muted(`Requests still appear in the app. Resume early with ${command('greatping resume')}.`),
  );
  return 0;
}

export async function resume() {
  const config = requirePaired();
  await api<PauseMachineResponse>(config, 'PUT', '/machine/me/pause', { body: { until: null } });
  ui.success('Alerts from this computer are on.');
  return 0;
}
