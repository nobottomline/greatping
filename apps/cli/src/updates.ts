import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { configDir } from './config';
import { detectInstallation } from './installation';
import { command, interactive, muted, spinner, ui } from './ui';
import { VERSION } from './version';

const DAY = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
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

/** Bound the entire lookup, including the body, even if a fetch adapter hangs. */
async function latestVersion(signal?: AbortSignal): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(REGISTRY, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
            : AbortSignal.timeout(3000),
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error('npm lookup failed');
        const data: unknown = await response.json();
        const latest =
          data && typeof data === 'object' ? (data as { latest?: unknown }).latest : null;
        if (!stableVersion(latest)) throw new Error('Invalid npm metadata');
        return latest;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('npm lookup timed out')), 3000);
        abort = () => reject(new Error('npm lookup cancelled'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

function updateHint(): string {
  const installation = detectInstallation();
  return installation.updateCommand
    ? `Update with ${command(installation.updateCommand)}`
    : 'Update this installation using its original package manager or source checkout.';
}

/** Explicit checks bypass the cache and opt-out; they never install a package. */
export async function checkForUpdates(options: { json: boolean }): Promise<number> {
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const activity = options.json ? null : spinner('Checking npm for updates');
  try {
    const attemptedAt = Date.now();
    try {
      writeCache({ ...readCache(), attemptedAt });
    } catch {
      /* Optional cache. */
    }
    const latest = await latestVersion(controller.signal);
    const checkedAt = Date.now();
    try {
      if (readCache().attemptedAt === attemptedAt)
        writeCache({ attemptedAt: checkedAt, checkedAt, latest });
    } catch {
      /* A read-only home does not invalidate a successful lookup. */
    }
    const installation = detectInstallation();
    const updateAvailable = stableVersion(VERSION) && newer(latest, VERSION);
    activity?.stop();
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          current: VERSION,
          latest,
          updateAvailable,
          checkedAt,
          installation: {
            manager: installation.manager,
            updateCommand: installation.updateCommand,
          },
        })}\n`,
      );
    } else {
      ui.rows([
        ['Installed', VERSION],
        ['Latest on npm', latest],
      ]);
      if (updateAvailable) {
        ui.info('An update is available.');
        ui.next(updateHint());
      } else
        ui.success(
          newer(VERSION, latest) ? 'This version is ahead of npm latest.' : 'You are up to date.',
        );
    }
    return 0;
  } catch {
    activity?.stop();
    const error = exitCode
      ? 'Update check cancelled.'
      : 'Could not check npm for updates. Check your connection and try again.';
    if (options.json)
      process.stdout.write(
        `${JSON.stringify({ current: VERSION, latest: null, updateAvailable: null, error })}\n`,
      );
    else ui.error(error);
    return exitCode || 1;
  } finally {
    activity?.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

/** Runs in a separate, bounded process. No pairing data or npm credentials are read. */
export async function refreshUpdateCache(attemptedAt?: number): Promise<void> {
  try {
    const latest = await latestVersion();
    // A newer check or uninstall can supersede this detached worker. Do not
    // overwrite their state or recreate a cache removed while npm was pending.
    if (attemptedAt !== undefined && readCache().attemptedAt !== attemptedAt) return;
    const now = Date.now();
    writeCache({ attemptedAt: now, checkedAt: now, latest });
  } catch {
    // Offline, timeouts, malformed metadata and cache failures are silent.
  }
}

/** Commands stay fast; interactive help/version can briefly await the background check. */
export function prepareUpdateNotice(argv: string[]): () => void | Promise<void> {
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
    ['hook', 'mcp', 'uninstall', 'update'].includes(name ?? '') ||
    !stableVersion(VERSION)
  )
    return () => {};

  let worker: ChildProcess | undefined;
  try {
    const cache = readCache();
    const now = Date.now();
    if (now - cache.checkedAt >= CHECK_INTERVAL && now - cache.attemptedAt >= RETRY_INTERVAL) {
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
      worker = child;
    }
  } catch {
    // Checking for an update is optional, including when spawning is forbidden.
  }

  return async () => {
    if (
      worker &&
      [undefined, 'help', '--help', '-h', 'version', '--version', '-v'].includes(name) &&
      worker.exitCode === null &&
      worker.signalCode === null
    ) {
      const activity = spinner('Checking for updates');
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          worker?.off('exit', done);
          worker?.off('error', done);
          resolve();
        };
        const timer = setTimeout(done, 800);
        worker?.once('exit', done);
        worker?.once('error', done);
      });
      activity.stop();
    }
    const cache = readCache();
    if (
      !cache.latest ||
      Date.now() - cache.checkedAt > MAX_CACHE_AGE ||
      !newer(cache.latest, VERSION)
    )
      return;
    ui.blank();
    ui.info(`Update available ${muted(VERSION)} → ${cache.latest}`);
    ui.next(updateHint());
  };
}
