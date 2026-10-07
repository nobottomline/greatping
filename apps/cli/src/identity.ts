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
  /**
   * Projects alerts named recently, by opaque key: lets a device's command for
   * a key reach the project's root, and the report list them. Local only.
   */
  recent: z
    .record(z.string(), z.strictObject({ root: z.string(), seenAt: z.number() }))
    .default({}),
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
    recent: {},
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
  const projectKey = opaque(settings.secret, 'project', root);
  noteRecent(settings, projectKey, root);
  const override = settings.projects[root];
  if (override && 'hidden' in override) return {};
  const label = (override?.name ?? basename(root)).slice(0, LIMITS.projectLabelMaxLength).trim();
  return { projectKey, ...(label ? { projectLabel: label } : {}) };
}

/** Projects listed to devices: seen within the history window, newest first. */
const RECENT_DAYS = LIMITS.historyRetentionDays;
const RECENT_MAX = 50;
/** A project already listed is re-stamped at most this often, to keep hook writes rare. */
const RECENT_REFRESH_MS = 3600 * 1000;

function noteRecent(settings: Settings, key: string, root: string, now = Date.now()) {
  const known = settings.recent[key];
  if (known && known.root === root && now - known.seenAt < RECENT_REFRESH_MS) return;
  try {
    update((current) => {
      current.recent[key] = { root, seenAt: now };
      const cutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
      const kept = Object.entries(current.recent)
        .filter(([, project]) => project.seenAt > cutoff)
        .sort(([, a], [, b]) => b.seenAt - a.seenAt)
        .slice(0, RECENT_MAX);
      current.recent = Object.fromEntries(kept);
    });
  } catch {
    // Listing is a convenience; an alert never fails over it.
  }
}

/** The recent projects as devices see them: folder name, a set name, hidden. */
export function recentProjects(now = Date.now()) {
  const settings = readSettings();
  if (!settings) return [];
  const cutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  return Object.entries(settings.recent)
    .filter(([, project]) => project.seenAt > cutoff)
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, RECENT_MAX)
    .flatMap(([key, { root }]) => {
      const label = basename(root).slice(0, LIMITS.projectLabelMaxLength).trim();
      if (!label) return [];
      const override = settings.projects[root];
      return [
        {
          key,
          label,
          ...(override && 'name' in override ? { name: override.name } : {}),
          ...(override && 'hidden' in override ? { hidden: true } : {}),
        },
      ];
    });
}

/**
 * Applies a device's rename or hide of a recent project to the local
 * overrides `greatping project` uses. Returns false for an unknown key.
 */
export function applyProjectCommand(
  key: string,
  command: { name?: string | null | undefined; hidden?: boolean | undefined },
): boolean {
  const root = readSettings()?.recent[key]?.root;
  if (!root) return false;
  update((settings) => {
    const current = settings.projects[root];
    let next: ProjectOverride | null = current ?? null;
    if (command.hidden === true) next = { hidden: true };
    else if (command.hidden === false && next && 'hidden' in next) next = null;
    if (command.name !== undefined && command.hidden !== true)
      next = command.name === null ? null : { name: command.name };
    if (next) settings.projects[root] = next;
    else delete settings.projects[root];
  });
  return true;
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
