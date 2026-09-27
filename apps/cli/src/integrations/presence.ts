import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { findOnPath } from './launcher';

/** Without input for this long, the user is treated as away from the computer. */
export const AWAY_AFTER_SEC = 120;

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
  } catch {
    return null;
  }
}

/**
 * Seconds since the last keyboard or mouse input, or null where it cannot be
 * read (Windows, Linux without X11 idle support, remote shells).
 */
export function idleSeconds(): number | null {
  if (platform() === 'darwin') {
    const out = run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime']);
    const match = out?.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return match?.[1] ? Math.floor(Number(match[1]) / 1e9) : null;
  }
  if (platform() === 'linux' && process.env.DISPLAY) {
    const xprintidle = findOnPath('xprintidle');
    const out = xprintidle ? run(xprintidle, []) : null;
    const ms = out ? Number.parseInt(out, 10) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

/**
 * True when nobody has used the computer for a while, so an attention alert
 * should skip the presence delay. Unknown presence is not away: the alert then
 * waits the delay, which only costs time, never an alert.
 */
export function isAway(): boolean {
  const idle = idleSeconds();
  return idle !== null && idle >= AWAY_AFTER_SEC;
}
