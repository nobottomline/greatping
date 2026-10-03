import { basename } from 'node:path';
import process from 'node:process';
import {
  LIMITS,
  type ProjectLabels,
  type ProjectLabelsBody,
  type ProjectLabelsResponse,
} from '@greatping/protocol';
import { api } from '../api';
import { isPaired, loadConfig } from '../config';
import {
  cachedProjectLabels,
  type ProjectOverride,
  projectOverrides,
  projectRoot,
  rememberProjectLabels,
  setProjectOverride,
} from '../identity';
import { command, muted, print, ui } from '../ui';
import { UsageError } from './usage';

/** Sets whether this computer's alerts carry project labels, on the server and locally. */
export async function setProjectLabels(mode: ProjectLabels): Promise<ProjectLabels> {
  const config = loadConfig();
  if (!isPaired(config))
    throw new UsageError(null, 'This computer is not paired.', 'Run greatping login first.');
  const body: ProjectLabelsBody = { mode };
  const res = await api<ProjectLabelsResponse>(config, 'PUT', '/machine/me/project-labels', {
    body,
    signal: AbortSignal.timeout(8000),
  });
  rememberProjectLabels(res.projectLabels);
  return res.projectLabels;
}

/** What an alert from `root` shows, in words. */
function describe(root: string, mode: ProjectLabels, override: ProjectOverride | undefined) {
  if (mode === 'hidden') return 'no project label (project labels are hidden on this computer)';
  if (override && 'hidden' in override) return 'no project label (hidden for this project)';
  return `"${override?.name ?? basename(root)}"`;
}

export async function project(
  action: string | undefined,
  args: string[],
  options: { json?: boolean },
): Promise<number> {
  const root = projectRoot(process.cwd());
  switch (action ?? 'show') {
    case 'show': {
      const mode = cachedProjectLabels();
      const override = projectOverrides()[root];
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ root, mode, override: override ?? null })}\n`);
        return 0;
      }
      print(`  Project   ${root}`);
      print(`  Alerts    ${describe(root, mode, override)}`);
      if (mode === 'hidden')
        ui.next(muted(`Show folder names with ${command('greatping project labels folder')}.`));
      return 0;
    }
    case 'labels': {
      const mode = args[0];
      if (mode !== 'folder' && mode !== 'hidden')
        throw new UsageError('project', 'Choose folder or hidden: greatping project labels folder');
      await setProjectLabels(mode);
      ui.success(
        mode === 'folder'
          ? 'Alerts from this computer now show the project folder name.'
          : 'Alerts from this computer no longer show project names.',
      );
      return 0;
    }
    case 'name': {
      const name = args.join(' ').trim();
      if (!name || name.length > LIMITS.projectLabelMaxLength)
        throw new UsageError(
          'project',
          `Write a name of at most ${LIMITS.projectLabelMaxLength} characters.`,
        );
      setProjectOverride(root, { name });
      ui.success(`Alerts from ${basename(root)} will show "${name}".`);
      if (cachedProjectLabels() === 'hidden')
        ui.next(
          muted(
            `Project labels are hidden on this computer; turn them on with ${command('greatping project labels folder')}.`,
          ),
        );
      return 0;
    }
    case 'hide':
      setProjectOverride(root, { hidden: true });
      ui.success(`Alerts from ${basename(root)} will not show a project name.`);
      return 0;
    case 'reset':
      setProjectOverride(root, null);
      ui.success(`${basename(root)} uses this computer's project label setting again.`);
      return 0;
    case 'list': {
      const overrides = projectOverrides();
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ mode: cachedProjectLabels(), projects: overrides })}\n`,
        );
        return 0;
      }
      const entries = Object.entries(overrides);
      print(`  Project labels: ${cachedProjectLabels()}`);
      if (entries.length === 0) print(`  ${muted('No project names or hidden projects.')}`);
      for (const [path, override] of entries)
        print(`  ${path}  ${'hidden' in override ? muted('hidden') : `"${override.name}"`}`);
      return 0;
    }
    default:
      throw new UsageError('project', `Unknown action "${action}".`);
  }
}
