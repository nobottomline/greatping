import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { configDir } from './config';
import { command, interactive, muted, ui } from './ui';
import { VERSION } from './version';

const DAY = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL = 60 * 60 * 1000;
const MAX_CACHE_AGE = 7 * DAY;
const REGISTRY = 'https://registry.npmjs.org/-/package/greatping/dist-tags';

interface UpdateCache {
  attemptedAt: number;
  checkedAt: number;
  latest: string | null;
}

// Public releases follow major.minor.patch. Never advertise a prerelease,
// arbitrary registry text or a version from an untrusted cache as a command.
function stableVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)
  );
}

function newer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function cachePath(): string {
  return join(configDir(), 'update-check.json');
}

function readCache(): UpdateCache {
  try {
    const data: unknown = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (data && typeof data === 'object') {
      const cache = data as UpdateCache;
      const now = Date.now();
      if (
        Number.isFinite(cache.attemptedAt) &&
        cache.attemptedAt >= 0 &&
        cache.attemptedAt <= now &&
        Number.isFinite(cache.checkedAt) &&
        cache.checkedAt >= 0 &&
        cache.checkedAt <= now &&
        (cache.latest === null || stableVersion(cache.latest))
      )
        return cache;
    }
  } catch {
    // Missing, corrupt or unwritable optional state never blocks a command.
  }
  return { attemptedAt: 0, checkedAt: 0, latest: null };
}

function writeCache(cache: UpdateCache): void {
  const path = cachePath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Runs in a separate, bounded process. No pairing data or npm credentials are read. */
export async function refreshUpdateCache(attemptedAt?: number): Promise<void> {
  try {
    const response = await fetch(REGISTRY, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return;
    const data: unknown = await response.json();
    const latest = data && typeof data === 'object' ? (data as { latest?: unknown }).latest : null;
    if (!stableVersion(latest)) return;
    // A newer check or uninstall can supersede this detached worker. Do not
    // overwrite their state or recreate a cache removed while npm was pending.
    if (attemptedAt !== undefined && readCache().attemptedAt !== attemptedAt) return;
    const now = Date.now();
    writeCache({ attemptedAt: now, checkedAt: now, latest });
  } catch {
    // Offline, timeouts, malformed metadata and cache failures are silent.
  }
}

/** Prepare a footer for a human command; network work never delays its result. */
export function prepareUpdateNotice(argv: string[]): () => void {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const [name] = own.filter((arg) => arg !== '--no-color' && arg !== '--no-update-check');
  if (
    !interactive ||
    !process.stdout.isTTY ||
    'NO_UPDATE_NOTIFIER' in process.env ||
    process.env.NODE_ENV === 'test' ||
    process.env.GITHUB_ACTIONS ||
    process.env.BUILD_NUMBER ||
    process.env.RUN_ID ||
    own.includes('--no-update-check') ||
    own.includes('--json') ||
    ['hook', 'mcp', 'uninstall', 'version', '--version', '-v'].includes(name ?? '') ||
    !stableVersion(VERSION)
  )
    return () => {};

  try {
    const cache = readCache();
    const now = Date.now();
    if (now - cache.checkedAt >= DAY && now - cache.attemptedAt >= RETRY_INTERVAL) {
      // Reserve before spawning to avoid a child per invocation while offline.
      writeCache({ ...cache, attemptedAt: now });
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./update-check.js', import.meta.url)), String(now)],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.on('error', () => {});
      child.unref();
    }
  } catch {
    // Checking for an update is optional, including when spawning is forbidden.
  }

  return () => {
    const cache = readCache();
    if (
      !cache.latest ||
      Date.now() - cache.checkedAt > MAX_CACHE_AGE ||
      !newer(cache.latest, VERSION)
    )
      return;
    ui.blank();
    ui.info(`Update available ${muted(VERSION)} → ${cache.latest}`);
    ui.next(`Update with ${command('npm install --global greatping@latest')}`);
  };
}
