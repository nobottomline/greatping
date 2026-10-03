import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type AlertHost, LIMITS, type ProjectLabels } from '@greatping/protocol';
import { z } from 'zod';
import { configDir } from './config';

/**
 * What a computer derives locally to describe an alert without revealing what
 * it is about: opaque ids for chat threads, prompts and projects, and the
 * project labels the user allows. Raw session ids and paths never leave the
 * computer; ids are keyed with a per-computer secret, so they cannot be
 * guessed from a known path or session id.
 */

const overrideSchema = z.union([
  z.strictObject({ name: z.string().trim().min(1).max(LIMITS.projectLabelMaxLength) }),
  z.strictObject({ hidden: z.literal(true) }),
]);
export type ProjectOverride = z.infer<typeof overrideSchema>;

const settingsSchema = z.object({
  version: z.literal(1),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The computer's project-label mode as the server last reported it. */
  projectLabels: z.enum(['folder', 'hidden']).default('hidden'),
  /** Per-project overrides, keyed by the project root path. */
  projects: z.record(z.string(), overrideSchema).default({}),
});
type Settings = z.infer<typeof settingsSchema>;

export const identityPath = () => join(configDir(), 'alerts.json');

/**
 * Writes the settings whole under a temporary name, so concurrent hooks never
 * read half a file. `exclusive` publishes only if no file exists yet.
 */
function save(settings: Settings, exclusive = false): boolean {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${identityPath()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  if (!exclusive) {
    renameSync(temporary, identityPath());
    return true;
  }
  try {
    linkSync(temporary, identityPath());
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function read(): Settings | null {
  if (!existsSync(identityPath())) return null;
  return settingsSchema.parse(JSON.parse(readFileSync(identityPath(), 'utf8')));
}

/** The settings if they exist; never writes. Commands that only look use this. */
export function readSettings(): Settings | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Local alert settings, created with a fresh secret on first use. Hooks start
 * in parallel: only the first creator publishes its secret, the others read it.
 */
export function loadSettings(): Settings {
  let existing: Settings | null = null;
  try {
    existing = read();
    if (existing) return existing;
  } catch {
    // Corrupt: replaced below. The secret only keys ids of alerts still open.
  }
  const fresh: Settings = {
    version: 1,
    secret: randomBytes(32).toString('base64url'),
    projectLabels: 'hidden',
    projects: {},
  };
  if (existsSync(identityPath())) {
    save(fresh);
    return fresh;
  }
  if (save(fresh, true)) return fresh;
  return read() ?? fresh;
}

function update(change: (settings: Settings) => void): Settings {
  const settings = loadSettings();
  change(settings);
  save(settings);
  return settings;
}

/** A 22-character id derived from the secret; the same input always gives the same id. */
function opaque(secret: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(secret);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('base64url').slice(0, 22);
}

/** Thread id of a host's chat session. */
export function threadId(host: AlertHost, sessionId: string, secret = loadSettings().secret) {
  return opaque(secret, 'thread', host, sessionId);
}

/** Id of one prompt within a thread, from whatever correlates its events. */
export function correlationId(
  host: AlertHost,
  sessionId: string,
  correlation: string,
  secret = loadSettings().secret,
) {
  return opaque(secret, 'prompt', host, sessionId, correlation);
}

/**
 * The project a directory belongs to: the root of its git repository or
 * worktree (a `.git` directory or file), otherwise the directory itself.
 */
export function projectRoot(directory: string): string {
  let current = resolve(directory);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(directory);
    current = parent;
  }
}

/** What an alert says about its project, under the computer's mode and overrides. */
export function projectFields(
  directory: string | undefined,
  given?: Settings,
): { projectKey?: string; projectLabel?: string } {
  // Labels are off until chosen; only then is a secret needed for the key.
  if (!directory || (given ?? readSettings())?.projectLabels !== 'folder') return {};
  const settings = given ?? loadSettings();
  let root: string;
  try {
    if (!statSync(directory).isDirectory()) return {};
    root = projectRoot(directory);
  } catch {
    return {};
  }
  const override = settings.projects[root];
  if (override && 'hidden' in override) return {};
  const label = (override?.name ?? basename(root)).slice(0, LIMITS.projectLabelMaxLength).trim();
  return {
    projectKey: opaque(settings.secret, 'project', root),
    ...(label ? { projectLabel: label } : {}),
  };
}

export function cachedProjectLabels(): ProjectLabels {
  return readSettings()?.projectLabels ?? 'hidden';
}

/** Records the mode the server reported, so hooks need not ask before every alert. */
export function rememberProjectLabels(mode: ProjectLabels): void {
  if (cachedProjectLabels() !== mode) {
    update((settings) => {
      settings.projectLabels = mode;
    });
  }
}

export function projectOverrides(): Record<string, ProjectOverride> {
  return readSettings()?.projects ?? {};
}

export function setProjectOverride(root: string, override: ProjectOverride | null): void {
  update((settings) => {
    if (override) settings.projects[root] = override;
    else delete settings.projects[root];
  });
}
