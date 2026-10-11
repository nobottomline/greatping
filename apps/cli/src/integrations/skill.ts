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
import { canonicalSkillPath, managedSkillInstalled } from './managed-skills';
import { nativeHome } from './native-adapters';
import { fingerprint, forgetAsset, ownedAssets, recordAsset } from './ownership';
import { claudeHome } from './plugins';
import type { HostId } from './state';

/**
 * The GreatPing agent skill. Its source is `skills/greatping/SKILL.md` at the
 * repository root, which `npx skills add` also installs; the build copies it
 * next to the CLI so an installed CLI can set it up offline.
 */

/** Where each host reads user-level skills. */
export function skillDir(host: HostId): string {
  if (host === 'cursor') return join(nativeHome(host), 'skills', 'greatping');
  if (host === 'opencode' || host === 'pi') return join(nativeHome(host), 'skills', 'greatping');
  return host === 'claude'
    ? join(claudeHome(), 'skills', 'greatping')
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

/**
 * Who owns a host's GreatPing skill and whether it matches this CLI.
 * - `current`/`outdated`: the bundled copy, unchanged since this CLI wrote it
 *   (or a recognized legacy bundled copy), matching this CLI or an older one.
 * - `modified`: the bundled copy, edited afterwards; it is never overwritten.
 * - `managed`: installed through `npx skills`, which also updates it.
 * - `external`: a GreatPing skill installed some other way; left alone.
 * - `foreign`: another skill, or a broken link, occupies the directory.
 */
export type SkillState =
  | 'absent'
  | 'current'
  | 'outdated'
  | 'modified'
  | 'managed'
  | 'external'
  | 'foreign';

const legacySkillHashes = new Set([
  'a93d2819e14345dc306ec3621d814f533b9a6683ce2e830a576df88a1bc4c5d3',
]);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** A plain directory holding only an unchanged legacy bundled SKILL.md. */
function bundledCopy(dir: string): boolean {
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return false;
  if (readdirSync(dir).join() !== 'SKILL.md') return false;
  if (!lstatSync(join(dir, 'SKILL.md')).isFile()) return false;
  const hash = sha256(readFileSync(join(dir, 'SKILL.md')));
  return legacySkillHashes.has(hash);
}

export function skillState(host: HostId, content = bundledSkill()): SkillState {
  const dir = skillDir(host);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return 'absent';
  if (!isGreatPingSkill(dir)) return 'foreign';
  const link = lstatSync(dir).isSymbolicLink();
  if (managedSkillInstalled() && (link || dir === canonicalSkillPath())) return 'managed';
  const owned = ownedAssets().find((asset) => asset.kind === 'skill' && asset.path === dir);
  if (owned?.fingerprint && fingerprint(dir) !== owned.fingerprint) return 'modified';
  // An old journal entry without a hash grants no more ownership than an
  // unrecorded copy. Never follow a skill link when writing an update.
  if (link || !lstatSync(join(dir, 'SKILL.md')).isFile()) return 'external';
  if (!owned?.fingerprint && !bundledCopy(dir)) return 'external';
  return readFileSync(join(dir, 'SKILL.md'), 'utf8') === content ? 'current' : 'outdated';
}

/**
 * Installs or updates the bundled skill. A skill managed by `npx skills` or
 * installed another way is left as it is; edited or foreign files are an error.
 */
export function installSkill(host: HostId, content = bundledSkill()): void {
  const dir = skillDir(host);
  const state = skillState(host, content);
  if (state === 'managed' || state === 'external') return;
  if (state === 'foreign') throw new Error(`Another skill occupies ${dir}.`);
  if (state === 'modified') throw new Error(`The installed skill was changed: ${dir}.`);
  if (state !== 'current') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content, { mode: 0o644 });
  }
  recordAsset({ kind: 'skill', host, path: dir, fingerprint: fingerprint(dir) });
}

/** Removes the skill only when it is GreatPing's; returns whether it did. */
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
  // Without a journal entry, only an unedited copy of a known release is ours.
  if (owned ? fingerprint(dir) !== owned.fingerprint : !bundledCopy(dir))
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
