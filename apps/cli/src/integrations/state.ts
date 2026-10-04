import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@greatping/protocol';
import { configDir } from '../config';

/**
 * Local marks of the alerts a host's hooks opened, so the events that close a
 * prompt reach the server only when something may be open. The server owns
 * the alerts; a mark is an empty file `hook-state/<host>/<thread>/<prompt>`
 * named by the opaque ids that were sent. Nothing from the prompt is stored.
 */

export type HostId = 'claude' | 'codex';

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
        } else if (depth === 0 ? !name.endsWith('.seen') : now - info.mtimeMs > maxAge) {
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

// `.seen` keeps it out of `pruneAlerts`, like the per-host heartbeats.
const reportPath = () => join(root(), 'report.seen');

/**
 * Whether the hourly machine report is due. It keeps its own clock: hooks of a
 * busy session run every few minutes, so the time since the last hook never
 * reaches an hour while the computer is in use. Claims the slot when due, so
 * hooks running at once do not all report.
 */
export function claimReport(intervalMs: number, now = Date.now()): boolean {
  try {
    const last = statSync(reportPath()).mtimeMs;
    if (now - last < intervalMs) return false;
    utimesSync(reportPath(), now / 1000, now / 1000);
  } catch {
    try {
      mkdirSync(root(), { recursive: true, mode: 0o700 });
      writeFileSync(reportPath(), '', { mode: 0o600 });
      utimesSync(reportPath(), now / 1000, now / 1000);
    } catch {
      return false;
    }
  }
  return true;
}
