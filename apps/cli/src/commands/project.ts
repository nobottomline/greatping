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
import { withProgress } from '../progress';
import { color, command, muted, print, ui } from '../ui';
import { UsageError } from './usage';

export const PROJECT_ACTIONS: Array<[action: string, description: string]> = [
  ['show', 'Show the current project and its alert label'],
  ['labels folder', 'Show project names from this computer'],
  ['labels hidden', 'Hide all project names from this computer'],
  ['name <name>', 'Set a custom name for the current project'],
  ['hide', 'Hide the name of the current project'],
  ['reset', 'Remove the current project override'],
  ['list', 'List saved project names and hidden projects'],
];

/** Sets whether this computer's alerts carry project labels, on the server and locally. */
export async function setProjectLabels(
  mode: ProjectLabels,
  signal?: AbortSignal,
): Promise<ProjectLabels> {
  const config = loadConfig();
  if (!isPaired(config))
    throw new UsageError(null, 'This computer is not paired.', 'Run greatping login first.');
  const body: ProjectLabelsBody = { mode };
  const res = await api<ProjectLabelsResponse>(config, 'PUT', '/machine/me/project-labels', {
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
  });
  rememberProjectLabels(res.projectLabels);
  return res.projectLabels;
}

/** What an alert from `root` shows, in words. */
function describe(root: string, mode: ProjectLabels, override: ProjectOverride | undefined) {
  if (mode === 'hidden') return muted('hidden (project labels are hidden on this computer)');
  if (override && 'hidden' in override) return muted('hidden (only for this project)');
  return color.cyan(`"${override?.name ?? basename(root)}"`);
}

function computerMode(mode: ProjectLabels): string {
  return mode === 'folder' ? color.cyan('folder names') : muted('hidden');
}

export async function project(
  action: string | undefined,
  args: string[],
  options: { json?: boolean },
): Promise<number> {
  if (!action && !options.json) {
    ui.heading('Projects');
    ui.rows([['Computer labels (cached)', computerMode(cachedProjectLabels())]]);
    print();
    print(`  ${color.bold('Commands')}`);
    const width = Math.max(...PROJECT_ACTIONS.map(([name]) => name.length));
    for (const [name, description] of PROJECT_ACTIONS)
      print(`    ${command(`greatping project ${name.padEnd(width)}`)}  ${description}`);
    print();
    print(`  ${muted('name, hide and reset apply to the project in your current directory.')}`);
    ui.next(`Run ${command('greatping project --help')} for details and options.`);
    print();
    return 0;
  }
  const root = projectRoot(process.cwd());
  switch (action ?? 'show') {
    case 'show': {
      const mode = cachedProjectLabels();
      const override = projectOverrides()[root];
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ root, mode, override: override ?? null })}\n`);
        return 0;
      }
      ui.heading('Project');
      ui.rows([
        ['Project', color.bold(basename(root))],
        ['Folder', muted(root)],
        ['Computer labels (cached)', computerMode(mode)],
        ['Alerts', describe(root, mode, override)],
      ]);
      if (mode === 'hidden') {
        print();
        ui.next(`Show folder names with ${command('greatping project labels folder')}.`);
      } else if (override && 'hidden' in override) {
        print();
        ui.next(`Use the computer setting with ${command('greatping project reset')}.`);
      }
      print();
      return 0;
    }
    case 'labels': {
      const mode = args[0];
      if (mode !== 'folder' && mode !== 'hidden')
        throw new UsageError('project', 'Choose folder or hidden: greatping project labels folder');
      await withProgress(
        'Updating project labels in GreatPing',
        (signal) => setProjectLabels(mode, signal),
        {
          json: Boolean(options.json),
          interrupted:
            'Project-label update interrupted. GreatPing may have applied the change; run greatping status.',
        },
      );
      if (!options.json) ui.heading('Project labels');
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
      if (!options.json) ui.heading('Project');
      ui.success(
        `Project name for ${color.bold(basename(root))} saved as ${color.cyan(`"${name}"`)}.`,
      );
      if (cachedProjectLabels() === 'hidden')
        ui.next(
          `Project labels are hidden on this computer; turn them on with ${command('greatping project labels folder')}.`,
        );
      return 0;
    }
    case 'hide':
      setProjectOverride(root, { hidden: true });
      if (!options.json) ui.heading('Project');
      ui.success(`Alerts from ${color.bold(basename(root))} will not show a project name.`);
      return 0;
    case 'reset':
      setProjectOverride(root, null);
      if (!options.json) ui.heading('Project');
      ui.success(`${color.bold(basename(root))} uses this computer's project label setting again.`);
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
      ui.heading('Projects');
      ui.rows([['Computer labels (cached)', computerMode(cachedProjectLabels())]]);
      print();
      if (entries.length === 0) {
        print(`  ${muted('No project names or hidden projects.')}`);
        ui.next(`Set a name here with ${command('greatping project name "My project"')}.`);
      }
      for (const [path, override] of entries) {
        print(`  ${color.bold(basename(path))}`);
        ui.rows([
          ['Folder', muted(path)],
          ['Override', 'hidden' in override ? muted('hidden') : color.cyan(`"${override.name}"`)],
        ]);
        print();
      }
      if (entries.length === 0) print();
      return 0;
    }
    default:
      throw new UsageError('project', `Unknown action "${action}".`);
  }
}
