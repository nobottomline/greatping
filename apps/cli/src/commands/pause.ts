import { LIMITS } from '@greatping/protocol';
import { clock, parseDuration } from '../duration';
import { changePause } from '../operations';
import { command, muted, ui } from '../ui';
import { UsageError } from './usage';

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
  const res = await changePause(seconds);
  ui.success(`Alerts from this computer are paused until ${clock(res.alertsPausedUntil ?? 0)}.`);
  ui.next(
    muted(`Requests still appear in the app. Resume early with ${command('greatping resume')}.`),
  );
  return 0;
}

export async function resume() {
  await changePause(null);
  ui.success('Alerts from this computer are on.');
  return 0;
}
