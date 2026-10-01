import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedSkillInstalled } from './managed-skills';
import { fingerprint, forgetAsset, ownedAssets, recordAsset } from './ownership';
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
  if (managedSkillInstalled() && isGreatPingSkill(dir)) return;
  // A link from `npx skills` already points at a GreatPing skill; replacing it
  // would fork that install.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink() && isGreatPingSkill(dir)) return;
  if (existsSync(dir) && !isGreatPingSkill(dir)) throw new Error(`Another skill occupies ${dir}.`);
  const existing = ownedAssets().find((asset) => asset.kind === 'skill' && asset.path === dir);
  if (existing?.fingerprint && existsSync(dir) && fingerprint(dir) !== existing.fingerprint)
    throw new Error(`The installed skill was changed: ${dir}.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, { mode: 0o644 });
  recordAsset({ kind: 'skill', host, path: dir, fingerprint: fingerprint(dir) });
}

/** Removes the skill only when it is GreatPing's; returns whether it did. */
const legacySkillHashes = new Set([
  'a93d2819e14345dc306ec3621d814f533b9a6683ce2e830a576df88a1bc4c5d3',
]);
export function checkSkillRemoval(host: HostId): boolean {
  const dir = skillDir(host);
  if (!existsSync(dir)) {
    return false;
  }
  const owned = ownedAssets().find((asset) => asset.kind === 'skill' && asset.path === dir);
  if (!isGreatPingSkill(dir)) {
    if (owned) throw new Error(`The recorded skill was replaced or changed: ${dir}.`);
    return false;
  }
  const legacy =
    !lstatSync(dir).isSymbolicLink() &&
    readdirSync(dir).length === 1 &&
    legacySkillHashes.has(
      createHash('sha256')
        .update(readFileSync(join(dir, 'SKILL.md')))
        .digest('hex'),
    );
  if (owned ? fingerprint(dir) !== owned.fingerprint : !legacy)
    throw new Error(
      `Skill ownership is unknown or files changed: ${dir}. Remove it through its installer.`,
    );
  return true;
}

export function uninstallSkill(host: HostId): boolean {
  const dir = skillDir(host);
  if (!checkSkillRemoval(host)) {
    if (!existsSync(dir)) forgetAsset('skill', dir);
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  forgetAsset('skill', dir);
  return true;
}
