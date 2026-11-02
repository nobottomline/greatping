import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { SERVICE_ORIGIN } from '@greatping/protocol';
import type { Manifest } from '@greatping/protocol/crypto';
import { UsageError } from './commands/usage';
import { ensurePrivateStateDirectory } from './private-state';

export const DEFAULT_API_URL = SERVICE_ORIGIN;

/** Local readiness only: no credential, request, or phone delivery claim. */
export function pairingProblem(config: Config): 'unpaired' | 'environment_mismatch' | null {
  if (!isPaired(config)) return 'unpaired';
  return config.apiUrl === DEFAULT_API_URL ? null : 'environment_mismatch';
}

export interface QuestionCancellation {
  requestId: string;
  expiresAt: number;
}

export interface Config {
  apiUrl: string;
  machineId?: string;
  machineToken?: string;
  /** This computer's secret keys (base64url), created at pairing (docs/device-keys.md). */
  keys?: { sign: string; enc: string };
  /** The latest account manifest version this computer verified. */
  manifest?: Manifest;
  /** Exact final tag awaiting acknowledgement; replayed without another ceremony. */
  pendingCeremonyTag?: string;
  /** Only questions this caller explicitly cancelled; no prompt or answer content. */
  pendingQuestionCancellations?: QuestionCancellation[];
}

/**
 * The manifest encoding this CLI verifies (docs/pairing-v2.md). A manifest
 * saved without it was pinned by CLI 0.4 or earlier under the v1 encoding,
 * whose pairings nobody confirmed: it is ignored and the computer pairs again.
 */
const MANIFEST_ENCODING = 2;

export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (platform() === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.config'));
  return join(base, 'greatping');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** The service is built in. A saved URL binds an existing credential to its issuer. */
export function loadConfig(): Config {
  if (platform() === 'win32' && existsSync(configPath())) ensurePrivateStateDirectory(configDir());
  let saved: Record<string, unknown> = {};
  try {
    if (existsSync(configPath())) {
      const value: unknown = JSON.parse(readFileSync(configPath(), 'utf-8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        saved = value as Record<string, unknown>;
      }
    }
  } catch {
    // An unreadable config is treated as unpaired; never infer a credential's issuer.
  }
  const machineId = typeof saved.machineId === 'string' ? saved.machineId : undefined;
  const machineToken = typeof saved.machineToken === 'string' ? saved.machineToken : undefined;
  const paired = Boolean(machineId && machineToken);
  const apiUrl = paired
    ? typeof saved.apiUrl === 'string'
      ? saved.apiUrl.trim().replace(/\/+$/, '')
      : ''
    : DEFAULT_API_URL;
  if (!machineId || !machineToken) return { apiUrl };
  const config: Config = { apiUrl, machineId, machineToken };
  const keys = saved.keys as Record<string, unknown> | undefined;
  if (keys && typeof keys.sign === 'string' && typeof keys.enc === 'string')
    config.keys = { sign: keys.sign, enc: keys.enc };
  // Re-verified against the chain whenever it is used; a damaged one is dropped.
  if (
    saved.manifest &&
    typeof saved.manifest === 'object' &&
    saved.manifestEncoding === MANIFEST_ENCODING
  )
    config.manifest = saved.manifest as Manifest;
  if (
    typeof saved.pendingCeremonyTag === 'string' &&
    /^[A-Za-z0-9_-]{86}$/.test(saved.pendingCeremonyTag)
  )
    config.pendingCeremonyTag = saved.pendingCeremonyTag;
  if (Array.isArray(saved.pendingQuestionCancellations)) {
    const pending = saved.pendingQuestionCancellations
      .filter(
        (value): value is QuestionCancellation =>
          value !== null &&
          typeof value === 'object' &&
          typeof value.requestId === 'string' &&
          /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId) &&
          Number.isSafeInteger(value.expiresAt) &&
          value.expiresAt > 0,
      )
      .map(({ requestId, expiresAt }) => ({ requestId, expiresAt }));
    if (pending.length) config.pendingQuestionCancellations = pending;
  }
  return config;
}

/** Never send an existing credential to another environment or a config-supplied host. */
export function requireServer(config: Config): void {
  if (config.apiUrl === DEFAULT_API_URL) return;
  throw new UsageError(
    null,
    'This pairing belongs to a different or unknown GreatPing environment.',
    'Run greatping logout, then greatping login to pair with this version of GreatPing.',
  );
}

/** The complete local credential identity; manifest refreshes never replace it. */
export function samePairing(a: Config, b: Config): boolean {
  return (
    isPaired(a) &&
    isPaired(b) &&
    a.apiUrl === b.apiUrl &&
    a.machineId === b.machineId &&
    a.machineToken === b.machineToken &&
    a.keys?.sign === b.keys?.sign &&
    a.keys?.enc === b.keys?.enc &&
    a.manifest?.account === b.manifest?.account
  );
}

/**
 * Cross-process bakery lock: each writer owns a unique, atomically published
 * ticket. Unlike stealing a shared stale mutex, ignoring a dead writer cannot
 * remove a new writer's lock. Only synchronous filesystem work runs inside.
 */
function withConfigLock<T>(change: () => T, timeoutMs = 5000): T {
  const dir = configDir();
  ensurePrivateStateDirectory(dir);
  const prefix = '.config-lock-';
  const name = `${prefix}${process.pid}-${randomUUID()}`;
  const path = join(dir, name);
  const temporary = `${path}.tmp`;
  const deadline = Date.now() + timeoutMs;
  const pause = () => {
    if (Date.now() >= deadline) throw new Error('Local pairing is busy. Retry the command.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  };
  const tickets = () => readdirSync(dir).filter((n) => n.startsWith(prefix) && !n.endsWith('.tmp'));
  const read = (other: string): number | null => {
    const pid = Number(other.slice(prefix.length).split('-')[0]);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // This exact unique name can never belong to a later writer.
        rmSync(join(dir, other), { force: true });
        rmSync(join(dir, `${other}.tmp`), { force: true });
        return null;
      }
    }
    try {
      const value = readFileSync(join(dir, other), 'utf8');
      return value === '' ? 0 : Number(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  // Empty means this writer is choosing its ticket; peers wait for publication.
  writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  try {
    let ticket = 1;
    for (const other of tickets()) {
      const value = read(other);
      if (value !== null && Number.isSafeInteger(value)) ticket = Math.max(ticket, value + 1);
    }
    writeFileSync(temporary, String(ticket), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    for (const other of tickets()) {
      if (other === name) continue;
      for (;;) {
        const value = read(other);
        if (value === null || (value > 0 && (value > ticket || (value === ticket && other > name))))
          break;
        pause();
      }
    }
    return change();
  } finally {
    rmSync(temporary, { force: true });
    rmSync(path, { force: true });
  }
}

function writeConfig(config: Config): void {
  const temporary = `${configPath()}.${randomUUID()}.tmp`;
  const saved = config.manifest ? { ...config, manifestEncoding: MANIFEST_ENCODING } : config;
  try {
    writeFileSync(temporary, JSON.stringify(saved, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, configPath());
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Explicit pairing/replacement, atomically readable and private to this user. */
export function saveConfig(config: Config): void {
  withConfigLock(() => writeConfig(config));
}

/** Updates only the still-current pairing, preserving concurrent local changes. */
export function updateConfig(
  expected: Config,
  change: (current: Config) => Config | undefined,
  timeoutMs = 5000,
): Config {
  return withConfigLock(() => {
    const current = loadConfig();
    if (!samePairing(expected, current))
      throw new Error('Local pairing changed. Retry the command with the current pairing.');
    const next = change(current);
    if (next) writeConfig(next);
    return next ?? current;
  }, timeoutMs);
}

/** Removal uses the same lock as refresh and never deletes a newly paired identity. */
export function removeConfig(expected: Config): void {
  withConfigLock(() => {
    const current = loadConfig();
    if (isPaired(expected) ? !samePairing(expected, current) : isPaired(current))
      throw new Error('Local pairing changed. Retry removal with the current pairing.');
    rmSync(configPath(), { force: true });
  });
}

export function isPaired(
  config: Config,
): config is Config & { machineId: string; machineToken: string } {
  return Boolean(config.machineId && config.machineToken);
}
