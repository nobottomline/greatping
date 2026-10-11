import { isPaired, loadConfig, pairingProblem } from '../config';
import { HOST_IDS, inspectHost as readHost } from '../integrations';
import { HOSTS, installHooks, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp } from '../integrations/mcp';
import { installNativeAdapter, nativeHost } from '../integrations/native-adapters';
import { pluginCommand } from '../integrations/plugins';
import { executeRemoval, integrationRemoval } from '../integrations/removal';
import { installSkill, skillState } from '../integrations/skill';
import type { HostId } from '../integrations/state';
import { CommandInterrupted, withProgress } from '../progress';
import { reportMachineWithProgress } from '../report';
import { color, command, confirm, interactive, muted, print, ui } from '../ui';
import { interactiveSetup } from './setup-flow';
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
  if (!options.remove && pairingProblem(loadConfig()) === 'environment_mismatch') {
    ui.warn(
      'Saved pairing belongs to another environment. Components can be configured, but alerts cannot use this CLI until it is paired with a phone build for the same service.',
    );
  }
  if (only && nativeHost(only) && options.migrate)
    throw new UsageError('setup', '--migrate is for Claude/Codex direct integrations.');
  // A person at a terminal reviews one plan; scripts pass flags and --yes.
  if (interactive && !options.yes && !options.remove && !options.migrate)
    return interactiveSetup(targets, options, !only);
  const natives = targets.filter(nativeHost).filter((id) => only || inspectHost(id).detected);
  if (!options.remove && !options.migrate && natives.length) {
    for (const id of natives) {
      print(`  ${HOSTS[id].name}: install the bundled native adapter, tools and skill locally.`);
      if (!options.yes) throw new UsageError('setup', 'Confirm adapter installation with --yes.');
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
  const changes = ids.flatMap((id) => changesFor(id, options));
  if (changes.length === 0) {
    ui.info('Settings are already up to date.');
    print();
    return 0;
  }
  for (const change of changes) print(`  ${muted('•')} ${change.label}`);
  print();
  // Another tool's settings change only with consent: a prompt or --yes.
  if (!options.yes)
    throw new UsageError('setup', 'Confirm with --yes to change agent settings non-interactively.');
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
    } else ui.success(change.label);
  }
  const config = loadConfig();
  await reportMachineWithProgress(config);
  print();
  for (const id of new Set(changes.map((change) => change.host))) {
    ui.next(`${HOSTS[id].name}: ${HOSTS[id].activation}`);
  }
  if (!isPaired(config))
    ui.next(`Pair this computer to receive alerts: ${command('greatping login')}`);
  ui.next(`Check everything with ${command('greatping doctor')}.`);
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
  if (report.skill) {
    let outdated = false;
    try {
      outdated = skillState(id) === 'outdated';
    } catch {}
    parts.push(
      outdated
        ? `${color.yellow('skill update available')} ${muted('— greatping doctor --fix')}`
        : muted('skill'),
    );
  }
  return parts.join(muted(' · '));
}
