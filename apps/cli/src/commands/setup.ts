import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectLabels } from '@greatping/protocol';
import { z } from 'zod';
import { configDir, isPaired, loadConfig, pairingProblem } from '../config';
import { cachedProjectLabels } from '../identity';
import { HOST_IDS, inspectHost as readHost } from '../integrations';
import { CLAUDE_ALERTS, type ClaudeAlert } from '../integrations/events';
import { HOSTS, installHooks, selectedAlerts, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp, unregisterCodexMcp } from '../integrations/mcp';
import { installNativeAdapter, nativeHost } from '../integrations/native-adapters';
import { pluginCommand } from '../integrations/plugins';
import { executeRemoval, integrationRemoval } from '../integrations/removal';
import { installSkill } from '../integrations/skill';
import { setupSkills } from '../integrations/skills-cli';
import type { HostId } from '../integrations/state';
import { CommandInterrupted, withProgress } from '../progress';
import { reportMachineWithProgress } from '../report';
import { type PickerItem, pickSetup } from '../setup-picker';
import { color, command, confirm, interactive, muted, print, ui } from '../ui';
import { setProjectLabels } from './project';
import { UsageError } from './usage';

const inspectHost = (id: HostId) => readHost(id, true);

export function parseHost(name: string | undefined, usage: string): HostId | null {
  if (name === undefined || name === 'all') return null;
  const value = name.toLowerCase();
  if (value === 'claude' || value === 'claude-code') return 'claude';
  if (value === 'codex') return 'codex';
  if (nativeHost(value)) return value;
  throw new UsageError(
    usage,
    `Unknown agent "${name}". Supported: claude, codex, opencode, pi, cursor.`,
  );
}

export interface SetupOptions {
  /** Also alert when the agent finishes a turn; undefined keeps the current choice. */
  finished?: boolean;
  skill: boolean;
  remove: boolean;
  yes: boolean;
  /** Explicitly migrate owned direct integrations to an installed plugin. */
  migrate?: boolean;
}

async function setupPlugins(
  ids: HostId[],
  options: SetupOptions,
  confirmed: HostId[] = [],
): Promise<number | null> {
  let failed = false;
  for (const id of ids) {
    const report = inspectHost(id);
    const plugin = report.plugin;
    if (plugin.status === 'disabled' || plugin.status === 'unknown' || !plugin.path) {
      ui.error(
        `${report.host.name} plugin: ${plugin.problem ?? 'disabled; enable it in the native plugin manager.'}`,
      );
      failed = true;
      continue;
    }
    const removals = options.migrate ? integrationRemoval([id]) : [];
    print(
      `  ${report.host.name}: configure the installed GreatPing plugin (hooks, tools and skill).`,
    );
    for (const change of removals) print(`  • ${change.label}`);
    if (!options.yes && !confirmed.includes(id)) {
      if (!interactive)
        throw new UsageError(
          'setup',
          'Confirm with --yes to configure the installed plugin non-interactively.',
        );
      if (!(await confirm('Apply these plugin settings?', true))) {
        ui.info('Plugin setup cancelled.');
        return null;
      }
    }
    // Capture existing alert preferences before removing legacy hooks.
    const problem = pluginCommand(id, 'configure', currentLauncher(), options.finished);
    if (problem) {
      ui.error(`${report.host.name} plugin`, problem);
      failed = true;
      continue;
    }
    if (removals.length) {
      const removed = await withProgress(
        'Migrating direct agent setup to the plugin',
        (signal, update) => executeRemoval(removals, { signal, onAction: update }),
      );
      for (const result of removed) {
        if (result.status === 'failed') {
          failed = true;
          ui.error(result.label, result.error);
        }
      }
    }
    const checked = pluginCommand(id, 'check');
    if (checked) {
      failed = true;
      ui.error(`${report.host.name} plugin`, checked);
      if (!options.migrate && inspectHost(id).conflicts.length)
        ui.next(`Migrate owned direct integrations with greatping setup ${id} --migrate.`);
    } else ui.success(`${report.host.name} plugin configured: hooks, tools and skill.`);
    ui.next(
      `${report.host.name}: restart the host or reconnect MCP${id === 'codex' ? '; review hook trust in /hooks' : ''}.`,
    );
  }
  if (!isPaired(loadConfig())) ui.next('Pair this computer with greatping login.');
  await reportMachineWithProgress(loadConfig());
  return failed ? 1 : Number(process.exitCode ?? 0);
}

interface Change {
  host: HostId;
  label: string;
  apply(): string | null;
}

interface Selection {
  alerts: ClaudeAlert[];
  finished: boolean;
  mcp: boolean;
}

const selectionSchema = z.object({
  alerts: z.array(z.enum(CLAUDE_ALERTS)),
  finished: z.boolean(),
  mcp: z.boolean(),
});

function rememberedSelections(): Partial<Record<HostId, Selection>> {
  try {
    const saved = JSON.parse(readFileSync(join(configDir(), 'setup-options.json'), 'utf8'));
    const selections: Partial<Record<HostId, Selection>> = {};
    for (const id of HOST_IDS) {
      const parsed = selectionSchema.safeParse(saved?.[id]);
      if (parsed.success) selections[id] = parsed.data;
    }
    return selections;
  } catch {
    return {};
  }
}

function initialSelection(id: HostId, options: SetupOptions): Selection {
  const report = inspectHost(id);
  const previous = rememberedSelections()[id];
  const fresh =
    report.hooks.status === 'off' && !report.skill && !report.mcp.registered && !previous;
  return {
    alerts:
      report.hooks.status !== 'off'
        ? selectedAlerts(HOSTS[id])
        : (previous?.alerts ?? [...CLAUDE_ALERTS]),
    finished:
      options.finished ??
      (report.hooks.status !== 'off'
        ? report.hooks.finished
        : (previous?.finished ?? (id === 'codex' && fresh))),
    mcp: id === 'codex' && (report.mcp.registered || fresh),
  };
}

const PROJECT_ITEM = 'projects:labels';

/** Whether alerts name their project ("Codex · billing-api"); off until chosen. */
function projectItem(labels: ProjectLabels): PickerItem {
  return {
    id: PROJECT_ITEM,
    group: 'Projects',
    label: 'Show project folder names',
    hint: 'Alerts name the git repository folder, e.g. "Codex · billing-api". Rename or hide a project with greatping project.',
    selected: labels === 'folder',
  };
}

function pickerItems(ids: HostId[], selections: Map<HostId, Selection>): PickerItem[] {
  return ids.flatMap((id) => {
    const selection = selections.get(id);
    if (!selection) return [];
    const group = HOSTS[id].name;
    const item = (key: string, label: string, hint: string, selected: boolean): PickerItem => ({
      id: `${id}:${key}`,
      group,
      label,
      hint,
      selected,
    });
    const rows =
      id === 'claude'
        ? [
            item(
              'questions',
              'Questions',
              'Alert when Claude asks you a question.',
              selection.alerts.includes('questions'),
            ),
            item(
              'permissions',
              'Permissions',
              'Alert when Claude asks you to approve an action.',
              selection.alerts.includes('permissions'),
            ),
            item(
              'tool-input',
              'Tool input',
              'Alert when a connected tool asks for your input.',
              selection.alerts.includes('tool-input'),
            ),
          ]
        : [];
    rows.push(
      item(
        'finished',
        'Finished responses',
        `Alert after each response when ${group} waits for you.`,
        selection.finished,
      ),
    );
    if (id === 'codex')
      rows.push(
        item(
          'mcp',
          'Agent tools',
          'Let Codex send a ping or ask a question through GreatPing.',
          selection.mcp,
        ),
      );
    return rows;
  });
}

function rememberSelections(selections: Map<HostId, Selection>): void {
  const file = join(configDir(), 'setup-options.json');
  const existing = rememberedSelections();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ ...existing, ...Object.fromEntries(selections) }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function selectedChanges(id: HostId, selection: Selection): Change[] {
  const report = inspectHost(id),
    host = HOSTS[id],
    changes: Change[] = [];
  const add = (label: string, apply: Change['apply']) => changes.push({ host: id, label, apply });
  const enabled =
    id === 'codex' ? selection.finished : selection.finished || selection.alerts.length > 0;
  const sameAlerts =
    id === 'codex' || selectedAlerts(host).join(',') === selection.alerts.join(',');
  if (
    enabled &&
    (report.hooks.status !== 'ok' || report.hooks.finished !== selection.finished || !sameAlerts)
  ) {
    add(`${host.name} alerts`, () => {
      installHooks(host, currentLauncher(), selection.finished, selection.alerts);
      return null;
    });
  } else if (!enabled && report.hooks.status !== 'off') {
    add(`${host.name} alerts off`, () => {
      uninstallHooks(host);
      return null;
    });
  }
  if (id === 'codex') {
    if (selection.mcp && (!report.mcp.registered || report.mcp.problem))
      add('Codex agent tools', () => registerCodexMcp(currentLauncher()));
    else if (!selection.mcp && report.mcp.registered)
      add('Codex agent tools off', () =>
        unregisterCodexMcp() ? null : 'Could not remove the Codex tools.',
      );
  }
  return changes;
}

/** What setting up (or removing) GreatPing changes for one host. */
function changesFor(id: HostId, options: SetupOptions): Change[] {
  const host = HOSTS[id];
  const report = inspectHost(id);
  const changes: Change[] = [];

  const launcher = currentLauncher();
  if (id === 'claude') {
    const finished = options.finished ?? report.hooks.finished;
    changes.push({
      host: id,
      label: `Alert when Claude Code asks a question or needs a permission${finished ? ', and when it finishes a turn' : ''}`,
      apply: () => {
        installHooks(host, launcher, finished);
        return null;
      },
    });
  } else if (options.finished === false) {
    if (report.hooks.status !== 'off') {
      changes.push({
        host: id,
        label: 'Stop alerting when Codex finishes a turn',
        apply: () => {
          uninstallHooks(host);
          return null;
        },
      });
    }
  } else {
    changes.push({
      host: id,
      label: 'Alert when Codex finishes a turn and waits for you',
      apply: () => {
        installHooks(host, launcher, true);
        return null;
      },
    });
  }
  if (id === 'codex' && (!report.mcp.registered || report.mcp.problem)) {
    changes.push({
      host: id,
      label: 'Give Codex GreatPing notification, question, status and pause tools over MCP',
      apply: () => registerCodexMcp(launcher),
    });
  }
  if (options.skill) {
    changes.push({
      host: id,
      label: `Install the GreatPing skill for ${host.name} (ping me when…, pause alerts…)`,
      apply: () => {
        installSkill(id);
        return null;
      },
    });
  }
  return changes;
}

export async function setup(target: string | undefined, options: SetupOptions): Promise<number> {
  const only = parseHost(target, 'setup');
  const targets = only ? [only] : HOST_IDS;
  const natives = targets.filter(nativeHost).filter((id) => only || inspectHost(id).detected);
  if (!options.remove && pairingProblem(loadConfig()) === 'environment_mismatch') {
    ui.warn(
      'Saved pairing belongs to another environment. Components can be configured, but alerts cannot use this CLI until it is paired with a phone build for the same service.',
    );
  }
  if (only && nativeHost(only) && options.migrate)
    throw new UsageError('setup', '--migrate is for Claude/Codex direct integrations.');
  if (!options.remove && !options.migrate && natives.length) {
    for (const id of natives) {
      print(`  ${HOSTS[id].name}: install the bundled native adapter, tools and skill locally.`);
      if (!options.yes) {
        if (!interactive) throw new UsageError('setup', 'Confirm adapter installation with --yes.');
        if (!(await confirm('Install this native adapter?', true))) return 0;
      }
      try {
        installNativeAdapter(id);
      } catch (error) {
        ui.error(
          'Native adapter setup',
          error instanceof Error ? error.message : 'Installation failed.',
        );
        return 1;
      }
    }
  }

  const plugins = targets.filter(
    (id) => (!options.migrate || !nativeHost(id)) && inspectHost(id).plugin.status !== 'absent',
  );
  if (options.migrate && (options.remove || !plugins.length))
    throw new UsageError(
      'setup',
      '--migrate requires an installed GreatPing plugin and cannot be combined with --remove.',
    );
  if (options.remove) {
    const changes = integrationRemoval(only ? [only] : HOST_IDS);
    ui.heading('Remove agent setup');
    for (const id of plugins.filter((id) => !nativeHost(id)))
      ui.info(
        `${HOSTS[id].name} plugin remains installed; remove it through ${id === 'claude' ? 'claude plugin uninstall' : 'codex plugin remove'} greatping@greatping.`,
      );
    for (const change of changes) print(`  • ${change.label}`);
    if (!changes.length) {
      ui.info('No GreatPing agent setup was found.');
      return 0;
    }
    if (!options.yes) {
      if (!interactive)
        throw new UsageError(
          'setup',
          'Confirm with --yes to change agent settings non-interactively.',
        );
      if (!(await confirm('Remove these?', false))) return Number(process.exitCode ?? 0);
    }
    const results = await withProgress(
      'Removing agent setup',
      (signal, update) => executeRemoval(changes, { signal, onAction: update }),
      {
        interrupted:
          'Setup removal interrupted. Some changes may already be applied; run greatping doctor.',
      },
    );
    for (const result of results) {
      if (result.status === 'failed') ui.error(result.label, result.error);
      else ui.success(result.label);
    }
    await reportMachineWithProgress(loadConfig());
    return results.some((result) => result.status === 'failed') ? 1 : 0;
  }
  const pluginCode = plugins.length
    ? await setupPlugins(plugins, options, options.migrate ? [] : natives)
    : 0;
  if (pluginCode === null) return Number(process.exitCode ?? 0);
  if (pluginCode !== 0 || options.migrate) return pluginCode;
  const ids = targets.filter(
    (id) => !nativeHost(id) && !plugins.includes(id) && (only || inspectHost(id).detected),
  );
  if (!ids.length && plugins.length) return 0;
  ui.heading(options.remove ? 'Remove agent setup' : 'Set up your agents');
  if (ids.length === 0) {
    ui.info('No supported agent host was found for this user.');
    ui.next(`Install one, then run ${command('greatping setup')} again.`);
    print();
    return 0;
  }
  let selections: Map<HostId, Selection> | null = null;
  if (interactive && !options.yes && !options.remove) {
    print(`  ${muted('Choose which alerts reach your devices.')}`);
    print();
    selections = new Map(ids.map((id) => [id, initialSelection(id, options)]));
    // Project labels are a setting of the paired computer; read it fresh first.
    const paired = isPaired(loadConfig());
    if (paired) await reportMachineWithProgress(loadConfig());
    const labels = cachedProjectLabels();
    const selected = await pickSetup([
      ...pickerItems(ids, selections),
      ...(paired ? [projectItem(labels)] : []),
    ]);
    if (selected === null) {
      ui.info('Setup cancelled. Nothing changed.');
      print();
      return Number(process.exitCode ?? 0);
    }
    for (const [id, selection] of selections) {
      selection.alerts = CLAUDE_ALERTS.filter((key) => selected.has(`${id}:${key}`));
      selection.finished = selected.has(`${id}:finished`);
      if (id === 'codex') selection.mcp = selected.has(`${id}:mcp`);
    }
    const wanted = selected.has(PROJECT_ITEM) ? 'folder' : 'hidden';
    if (paired && wanted !== labels) {
      try {
        await withProgress(
          'Updating project labels in GreatPing',
          (signal) => setProjectLabels(wanted, signal),
          {
            interrupted:
              'Project-label update interrupted. GreatPing may have applied the change; run greatping status.',
          },
        );
      } catch (error) {
        if (error instanceof CommandInterrupted) throw error;
        ui.error(
          'Project labels were not changed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  const changes = ids.flatMap((id) => {
    const selection = selections?.get(id);
    return selection ? selectedChanges(id, selection) : changesFor(id, options);
  });
  if (changes.length === 0) {
    if (selections) rememberSelections(selections);
    ui.info('Settings are already up to date.');
    print();
    return selections && options.skill ? setupSkills(only, ids) : 0;
  }
  if (!selections) {
    for (const change of changes) print(`  ${muted('•')} ${change.label}`);
    print();
  }
  // Another tool's settings change only with consent: a prompt or --yes.
  if (!options.yes && !selections) {
    if (!interactive) {
      throw new UsageError(
        'setup',
        'Confirm with --yes to change agent settings non-interactively.',
      );
    }
    if (!(await confirm(options.remove ? 'Remove these?' : 'Set these up?', true))) {
      ui.info('Nothing changed.');
      return Number(process.exitCode ?? 0);
    }
  }
  let failed = false;
  for (const change of changes) {
    let problem: string | null;
    try {
      problem = await withProgress(change.label, async () => change.apply(), {
        interrupted:
          'Setup interrupted. Some changes may already be applied; run greatping doctor.',
      });
    } catch (error) {
      if (error instanceof CommandInterrupted) throw error;
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      failed = true;
      ui.error(change.label, problem);
    } else if (!selections) ui.success(change.label);
  }
  const config = loadConfig();
  await reportMachineWithProgress(config);
  if (selections) {
    if (!failed) {
      rememberSelections(selections);
      ui.success('Agent settings saved.');
    }
    ui.rows(ids.map((id) => [HOSTS[id].name, hostSummary(id) ?? 'alerts off']));
    if (selections.get('codex')?.finished)
      ui.next('Codex: open /hooks to trust the hooks if asked.');
    if (!isPaired(config)) ui.next('Pair this computer with greatping login.');
    print();
    if (failed) return 1;
    return options.skill ? setupSkills(only, ids) : 0;
  }
  if (!options.remove) {
    print();
    for (const id of new Set(changes.map((change) => change.host))) {
      ui.next(`${HOSTS[id].name}: ${HOSTS[id].activation}`);
    }
    if (!isPaired(config))
      ui.next(`Pair this computer to receive alerts: ${command('greatping login')}`);
    ui.next(`Check everything with ${command('greatping doctor')}.`);
  }
  print();
  return failed ? 1 : 0;
}

/** One line per host for `status`: whether alerts work and how. */
export function hostSummary(id: HostId): string | null {
  const report = inspectHost(id);
  if (report.plugin.status !== 'absent') {
    const plugin = report.plugin;
    return [
      `plugin ${plugin.version ?? ''}`.trim(),
      plugin.status === 'ready' ? color.green('configured') : color.yellow(plugin.status),
      ...(report.conflicts.length
        ? [
            color.yellow(
              report.host.native
                ? 'duplicate skill — remove it through its installer'
                : 'integration conflict — greatping setup --migrate',
            ),
          ]
        : []),
      ...(id === 'codex' ? [muted('review trust in /hooks; finished turns only')] : []),
      ...(plugin.status === 'unconfigured' || plugin.status === 'broken'
        ? [muted(`greatping setup ${id}`)]
        : []),
    ].join(muted(' · '));
  }
  if (!report.detected && report.hooks.status === 'off' && !report.mcp.registered) return null;
  const parts: string[] = [];
  switch (report.hooks.status) {
    case 'ok':
      parts.push(color.green('alerts on'));
      break;
    case 'outdated':
      parts.push(`${color.yellow('alerts need an update')} ${muted('— greatping setup')}`);
      break;
    case 'broken':
      parts.push(`${color.red('alerts broken')} ${muted('— greatping doctor --fix')}`);
      break;
    default:
      parts.push(`${color.yellow('alerts off')} ${muted('— greatping setup')}`);
  }
  if (report.hooks.status !== 'off' && (id === 'codex' || report.hooks.finished)) {
    parts.push(muted('incl. finished turns'));
  }
  if (report.mcp.registered) parts.push(muted('tools'));
  if (report.skill) parts.push(muted('skill'));
  return parts.join(muted(' · '));
}
