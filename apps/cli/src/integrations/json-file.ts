import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

export type Json = Record<string, unknown>;

/** Reads a host's JSON settings; a missing file is empty, a broken one throws. */
export function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object.`);
  }
  return parsed as Json;
}

/** Writes atomically, keeping one backup of the user's original file. */
export function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.greatping-backup`)) {
    writeFileSync(`${path}.greatping-backup`, readFileSync(path), { mode: 0o600 });
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** One matcher group of a Claude Code or Codex hook event. */
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface HookHandler {
  type: 'command';
  command: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
}

export function hookGroups(settings: Json): Record<string, HookGroup[]> {
  const hooks = settings.hooks;
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? (hooks as Record<string, HookGroup[]>)
    : {};
}
