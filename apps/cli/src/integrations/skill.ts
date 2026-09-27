import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from './state';

/**
 * The GreatPing agent skill. Its source is `skills/greatping/SKILL.md` at the
 * repository root, which `npx skills add` also installs; the build copies it
 * next to the CLI so an installed CLI can set it up offline.
 */

/** Where each host reads user-level skills. */
export function skillDir(host: HostId): string {
  return host === 'claude'
    ? join(homedir(), '.claude', 'skills', 'greatping')
    : join(homedir(), '.agents', 'skills', 'greatping');
}

export function bundledSkill(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'SKILL.md'),
    join(here, '..', 'SKILL.md'),
    join(here, '..', '..', '..', '..', 'skills', 'greatping', 'SKILL.md'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error('The GreatPing skill is missing from this installation.');
}

function isGreatPingSkill(path: string): boolean {
  try {
    return /^name:\s*greatping\s*$/m.test(readFileSync(join(path, 'SKILL.md'), 'utf8'));
  } catch {
    return false;
  }
}

export function skillInstalled(host: HostId): boolean {
  return isGreatPingSkill(skillDir(host));
}

export function installSkill(host: HostId, content = bundledSkill()): void {
  const dir = skillDir(host);
  // A link from `npx skills` already points at a GreatPing skill; replacing it
  // would fork that install.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink() && isGreatPingSkill(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, { mode: 0o644 });
}

/** Removes the skill only when it is GreatPing's; returns whether it did. */
export function uninstallSkill(host: HostId): boolean {
  const dir = skillDir(host);
  if (!isGreatPingSkill(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
