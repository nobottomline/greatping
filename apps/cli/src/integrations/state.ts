import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@greatping/protocol';
import { configDir } from '../config';

/**
 * Local marks of the alerts a host's hooks opened, so the events that close a
 * prompt reach the server only when something may be open. The server owns
 * the alerts; a mark is an empty file `hook-state/<host>/<thread>/<prompt>`
 * named by the opaque ids that were sent. Nothing from the prompt is stored.
 */

export type HostId = 'claude' | 'codex' | 'opencode' | 'pi' | 'cursor';

export const ALERT_PROBLEMS = [
  'unpaired',
  'environment_mismatch',
  'revoked',
  'network',
  'timeout',
  'rate_limited',
  'service',
  'rejected',
  'local',
] as const;
export type AlertProblem = (typeof ALERT_PROBLEMS)[number];
export interface AlertAttempt {
  at: number;
  outcome: 'accepted' | 'failed';
  problem: AlertProblem | null;
}
// Store no event payloads, server messages, credentials or session identifiers.
const attemptPath = (host: HostId) => join(root(), `${host}.alert.json`);
export function recordAlert(host: HostId, problem: AlertProblem | null): void {
  const path = attemptPath(host);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    writeFileSync(
      temporary,
      JSON.stringify({ at: Date.now(), outcome: problem ? 'failed' : 'accepted', problem }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    // Diagnostics must never block or fail a host.
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Best effort. */
    }
  }
}
export function lastAlert(host: HostId): AlertAttempt | null {
  try {
    const value = JSON.parse(readFileSync(attemptPath(host), 'utf8'));
    if (!Number.isSafeInteger(value.at) || value.at < 0) return null;
    if (
      (value.outcome === 'accepted' && value.problem === null) ||
      (value.outcome === 'failed' && ALERT_PROBLEMS.includes(value.problem))
    )
      return { at: value.at, outcome: value.outcome, problem: value.problem };
  } catch {
    /* No verified diagnostic yet. */
  }
  return null;
}

function root(): string {
  return join(configDir(), 'hook-state');
}

function threadDir(host: HostId, thread: string): string {
  return join(root(), host, thread);
}

/**
 * Marks a prompt's alert as open. The server keeps one open alert per thread,
 * so earlier marks of the thread are dropped with it.
 */
export function markOpen(host: HostId, thread: string, correlation: string): void {
  const dir = threadDir(host, thread);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSafe(dir))
    if (name !== correlation) rmSync(join(dir, name), { force: true });
  writeFileSync(join(dir, correlation), '', { mode: 0o600 });
}

/** How long ago the prompt's alert was opened here, or null if it is not marked. */
export function openedAgo(
  host: HostId,
  thread: string,
  correlation?: string,
  now = Date.now(),
): number | null {
  const dir = threadDir(host, thread);
  const names = correlation ? [correlation] : readdirSafe(dir);
  let newest: number | null = null;
  for (const name of names) {
    try {
      const mtime = statSync(join(dir, name)).mtimeMs;
      newest = newest === null ? mtime : Math.max(newest, mtime);
    } catch {
      // Not marked.
    }
  }
  return newest === null ? null : Math.max(0, now - newest);
}

/** Forgets one prompt's mark, or the whole thread's. */
export function forget(host: HostId, thread: string, correlation?: string): void {
  rmSync(correlation ? join(threadDir(host, thread), correlation) : threadDir(host, thread), {
    recursive: true,
    force: true,
  });
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Removes alerts older than the longest an attention alert can stay open (the
 * server has expired them by then) and files from the previous flat layout.
 */
export function pruneAlerts(now = Date.now()): void {
  const maxAge = LIMITS.attentionTimeoutSec * 1000;
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) {
          if (depth < 2) walk(path, depth + 1);
          if (depth > 0 && readdirSync(path).length === 0) rmSync(path, { recursive: true });
        } else if (
          depth === 0
            ? !name.endsWith('.seen') && !name.endsWith('.alert.json')
            : now - info.mtimeMs > maxAge
        ) {
          rmSync(path, { force: true });
        }
      } catch {
        // Another hook may have removed it.
      }
    }
  };
  walk(root(), 0);
}

function heartbeatPath(host: HostId): string {
  return join(root(), `${host}.seen`);
}

/** When one of the host's hooks last ran here, or null if never. */
export function lastHookAt(host: HostId): number | null {
  try {
    return Math.floor(statSync(heartbeatPath(host)).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Records that a hook ran. Returns the previous run time, so the caller can
 * refresh what devices show when it is old.
 */
export function touchHeartbeat(host: HostId, now = Date.now()): number | null {
  const previous = lastHookAt(host);
  // A busy session runs hooks constantly; a minute's precision is enough.
  if (previous !== null && now - previous < 60_000) return previous;
  try {
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    if (previous === null) writeFileSync(heartbeatPath(host), '', { mode: 0o600 });
    else utimesSync(heartbeatPath(host), now / 1000, now / 1000);
  } catch {
    // Informational only.
  }
  return previous;
}

// `.seen` keeps stamps out of `pruneAlerts`, like the per-host heartbeats.
const stampPath = (name: string) => join(root(), `${name}.seen`);

/**
 * Claims a periodic slot named `name` when `intervalMs` has passed since the
 * last claim, so hooks running at once do not all do the same work. The
 * `.seen` file survives pruning.
 */
export function claimStamp(name: string, intervalMs: number, now = Date.now()): boolean {
  const path = stampPath(name);
  try {
    const last = statSync(path).mtimeMs;
    if (now - last < intervalMs) return false;
    utimesSync(path, now / 1000, now / 1000);
  } catch {
    try {
      mkdirSync(root(), { recursive: true, mode: 0o700 });
      writeFileSync(path, '', { mode: 0o600 });
      utimesSync(path, now / 1000, now / 1000);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether the hourly machine report is due. It keeps its own clock: hooks of a
 * busy session run every few minutes, so the time since the last hook never
 * reaches an hour while the computer is in use.
 */
export function claimReport(intervalMs: number, now = Date.now()): boolean {
  return claimStamp('report', intervalMs, now);
}
