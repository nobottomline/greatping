import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, forgetAsset, ownedAssets, recordAsset } from './ownership';

// Pin the manager used by setup and removal; hooks never download a runner.
export const SKILLS_RUNNER = 'skills@1.7.0';
export const skillsLockPath = () =>
  process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
    : join(homedir(), '.agents', '.skill-lock.json');
export const canonicalSkillPath = () => join(homedir(), '.agents', 'skills', 'greatping');

export function managedSkillInstalled(): boolean {
  if (!existsSync(skillsLockPath())) return false;
  const lock = JSON.parse(readFileSync(skillsLockPath(), 'utf8'));
  return lock?.skills?.greatping?.source === 'nobottomline/greatping';
}
export function recordManagedSkill(): void {
  if (managedSkillInstalled())
    recordAsset({
      kind: 'skills',
      path: skillsLockPath(),
      ...(existsSync(canonicalSkillPath())
        ? { fingerprint: fingerprint(canonicalSkillPath()) }
        : {}),
    });
}
export function checkManagedSkill(): void {
  if (!managedSkillInstalled())
    throw new Error(
      'The skills manager no longer identifies this skill as nobottomline/greatping.',
    );
  const asset = ownedAssets().find(
    (asset) => asset.kind === 'skills' && asset.path === skillsLockPath(),
  );
  if (
    asset?.fingerprint &&
    existsSync(canonicalSkillPath()) &&
    fingerprint(canonicalSkillPath()) !== asset.fingerprint
  )
    throw new Error(
      `The managed skill was changed: ${canonicalSkillPath()}. Review it before removal.`,
    );
}
export async function removeManagedSkill(agent?: 'claude-code' | 'codex'): Promise<void> {
  checkManagedSkill();
  const args = [
    '--yes',
    SKILLS_RUNNER,
    'remove',
    'greatping',
    '--global',
    '--yes',
    ...(agent ? ['--agent', agent] : []),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', args, {
      stdio: ['ignore', process.stderr, process.stderr],
      shell: process.platform === 'win32',
      env: { ...process.env, DISABLE_TELEMETRY: '1' },
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Skill removal timed out.'));
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`skills remove failed (${code ?? 'interrupted'}).`));
    });
  });
  if (!agent && (managedSkillInstalled() || existsSync(canonicalSkillPath())))
    throw new Error('The skills manager left the GreatPing skill installed.');
  // Managers may warn about failed link removal yet exit successfully. Check
  // native paths too, including dangling links that existsSync cannot see.
  const nativePaths = [
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'greatping'),
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'greatping'),
  ];
  const checked =
    agent === 'claude-code'
      ? nativePaths.slice(0, 1)
      : agent === 'codex'
        ? nativePaths.slice(1)
        : nativePaths;
  for (const path of checked) {
    let remains = false;
    try {
      lstatSync(path);
      remains = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (remains) throw new Error(`The skills manager left an agent skill entry: ${path}.`);
  }
  if (!managedSkillInstalled()) forgetAsset('skills', skillsLockPath());
}
