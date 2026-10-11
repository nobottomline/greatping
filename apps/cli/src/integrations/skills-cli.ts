import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, loadConfig } from '../config';
import { reportMachineWithProgress } from '../report';
import { command, confirm, interactive, muted, print, ui } from '../ui';
import { HOSTS } from './host-hooks';
import { recordManagedSkill, SKILLS_RUNNER } from './managed-skills';
import { inspectPlugin } from './plugins';
import { bundledSkill, installSkill, type SkillState, skillDir, skillState } from './skill';
import type { HostId } from './state';

export const SKILLS_ADD = `npx skills add nobottomline/greatping --skill greatping --global`;
const SKILLS_UPDATE = 'npx skills update greatping --global';
export const home = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

// Declining the skill for a host is remembered next to the alert choices, so
// a later setup does not offer it preselected again.
const optionsFile = () => join(configDir(), 'setup-options.json');
function savedOptions(): Record<string, unknown> {
  try {
    const saved = JSON.parse(readFileSync(optionsFile(), 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}
function entry(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function skillDeclined(id: HostId): boolean {
  return entry(savedOptions()[id]).skill === false;
}
export function rememberSkillChoices(choices: Map<HostId, boolean>): void {
  const saved = savedOptions();
  for (const [id, skill] of choices) saved[id] = { ...entry(saved[id]), skill };
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(optionsFile(), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}

/** Why a host's skill is not offered for installation, or null when it is. */
export function keptAsIs(id: HostId, state: SkillState): string | null {
  const name = HOSTS[id].name;
  switch (state) {
    case 'managed':
      return `${name}: installed with npx skills ${muted(`— update with ${command(SKILLS_UPDATE)}`)}`;
    case 'modified':
      return `${name}: the skill at ${home(skillDir(id))} was edited; it is kept as is`;
    case 'external':
      return `${name}: a GreatPing skill installed another way is kept as is`;
    case 'foreign':
      return `${name}: another skill occupies ${home(skillDir(id))}`;
    default:
      return null;
  }
}

/** Hand agent selection and installation to the upstream skills CLI. */
export async function runSkillsInstaller(): Promise<number> {
  const args = [
    '--yes',
    SKILLS_RUNNER,
    'add',
    'nobottomline/greatping',
    '--skill',
    'greatping',
    '--global',
  ];
  ui.next(command(`npx ${args.slice(1).join(' ')}`));
  print();
  // --yes approves fetching the npm runner; skills keeps its own prompts.
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npx', args, {
      // The arguments above are fixed; Windows runs npx.cmd.
      stdio: ['inherit', process.stderr, process.stderr],
      shell: process.platform === 'win32',
    });
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', forwardInt);
      process.off('SIGTERM', forwardTerm);
    };
    process.on('SIGINT', forwardInt);
    process.on('SIGTERM', forwardTerm);
    child.once('error', (error) => {
      cleanup();
      ui.error('Could not start npx skills.', error.message);
      resolve(1);
    });
    child.once('exit', (status, signal) => {
      cleanup();
      resolve(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
  if (code !== 0) {
    ui.warn('The skills installer did not complete. Your alert settings are saved.');
    ui.next(`Try again with ${command(SKILLS_ADD)}.`);
  }
  // Reconcile even after a partial install or cancellation.
  recordManagedSkill();
  return code;
}

/** Directly set-up hosts whose bundled skill is older than this CLI's. */
function outdatedSkills(): HostId[] {
  const content = bundledSkill();
  return (['claude', 'codex'] as const).filter(
    (id) => inspectPlugin(id).status === 'absent' && skillState(id, content) === 'outdated',
  );
}

/** After an update of this CLI: offer the matching skill, like setup would. */
export async function offerSkillUpdate(): Promise<number> {
  let hosts: HostId[];
  try {
    hosts = outdatedSkills();
  } catch {
    return 0;
  }
  if (!hosts.length) return 0;
  const names = hosts.map((id) => HOSTS[id].name).join(' and ');
  if (!interactive) {
    ui.next(
      `The GreatPing skill for ${names} is out of date: ${command('greatping doctor --fix')}`,
    );
    return 0;
  }
  if (!(await confirm(`The GreatPing skill for ${names} is out of date. Update it?`, true)))
    return Number(process.exitCode ?? 0);
  let failed = false;
  for (const id of hosts) {
    try {
      installSkill(id);
      ui.success(`Skill updated for ${HOSTS[id].name}`);
    } catch (error) {
      failed = true;
      ui.error(
        `Skill for ${HOSTS[id].name}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await reportMachineWithProgress(loadConfig());
  return failed ? 1 : 0;
}
