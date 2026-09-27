import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@greatping/protocol';
import { configDir } from '../config';

/**
 * Local memory of the alerts a host's hooks opened, so the event that closes a
 * prompt can resolve the same alert. Each open alert is one file holding its
 * source key: `hook-state/<host>/<session>/<alert>`. Names are hashes; nothing
 * from the prompt is stored.
 */

export type HostId = 'claude' | 'codex';

export interface OpenAlert {
  sourceKey: string;
  path: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

function root(): string {
  return join(configDir(), 'hook-state');
}

function sessionDir(host: HostId, session: string): string {
  return join(root(), host, hash(session));
}

function alertPath(host: HostId, session: string, correlation: string): string {
  return join(sessionDir(host, session), hash(correlation));
}

function readKey(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The alert for this prompt, created on first sight; a retried event reuses it. */
export function openAlert(host: HostId, session: string, correlation: string): OpenAlert {
  const path = alertPath(host, session, correlation);
  mkdirSync(sessionDir(host, session), { recursive: true, mode: 0o700 });
  const sourceKey = `${host}:${randomUUID()}`;
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, sourceKey);
    } finally {
      closeSync(fd);
    }
    return { sourceKey, path };
  } catch (error) {
    const existing = readKey(path);
    if (existing) return { sourceKey: existing, path };
    throw error;
  }
}

export function findAlert(host: HostId, session: string, correlation: string): OpenAlert | null {
  const path = alertPath(host, session, correlation);
  const sourceKey = readKey(path);
  return sourceKey ? { sourceKey, path } : null;
}

/** Every alert a session still has open. */
export function sessionAlerts(host: HostId, session: string): OpenAlert[] {
  const dir = sessionDir(host, session);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const sourceKey = readKey(path);
    return sourceKey ? [{ sourceKey, path }] : [];
  });
}

export function forgetAlert(alert: OpenAlert): void {
  rmSync(alert.path, { force: true });
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
