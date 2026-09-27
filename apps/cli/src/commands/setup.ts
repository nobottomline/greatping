import { isPaired, loadConfig } from '../config';
import { HOST_IDS, inspectHost } from '../integrations';
import { HOSTS, installHooks, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp, unregisterCodexMcp } from '../integrations/mcp';
import { installSkill, uninstallSkill } from '../integrations/skill';
import type { HostId } from '../integrations/state';
import { reportMachine } from '../report';
import { color, command, confirm, interactive, muted, print, ui } from '../ui';
import { UsageError } from './usage';

export function parseHost(name: string | undefined, usage: string): HostId | null {
  if (name === undefined || name === 'all') return null;
  const value = name.toLowerCase();
  if (value === 'claude' || value === 'claude-code') return 'claude';
  if (value === 'codex') return 'codex';
  throw new UsageError(usage, `Unknown agent "${name}". Supported: claude, codex.`);
}

export interface SetupOptions {
  /** Also alert when the agent finishes a turn; undefined keeps the current choice. */
  finished?: boolean;
  skill: boolean;
  remove: boolean;
  yes: boolean;
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
  if (options.remove) {
    if (report.hooks.status !== 'off') {
      changes.push({
        host: id,
        label: `Remove alerts from ${host.name}`,
        apply: () => {
          uninstallHooks(host);
          return null;
        },
      });
    }
    if (id === 'codex' && report.mcp.registered) {
      changes.push({
        host: id,
        label: 'Remove GreatPing tools from Codex',
        apply: () => {
          unregisterCodexMcp();
          return null;
        },
      });
    }
    if (report.skill) {
      changes.push({
        host: id,
        label: `Remove the GreatPing skill from ${host.name}`,
        apply: () => {
          uninstallSkill(id);
          return null;
        },
      });
    }
    return changes;
  }

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
      label: 'Give Codex the GreatPing tools (notify, ask_user) over MCP',
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
  const ids = only ? [only] : HOST_IDS.filter((id) => inspectHost(id).detected || options.remove);
  ui.heading(options.remove ? 'Remove agent setup' : 'Set up your agents');
  if (ids.length === 0) {
    ui.info('Neither Claude Code nor Codex was found for this user.');
    ui.next(`Install one, then run ${command('greatping setup')} again.`);
    print();
    return 0;
  }
  const changes = ids.flatMap((id) => changesFor(id, options));
  if (changes.length === 0) {
    ui.info('Nothing to change.');
    print();
    return 0;
  }
  for (const change of changes) print(`  ${muted('•')} ${change.label}`);
  print();
  // Another tool's settings change only with consent: a prompt or --yes.
  if (!options.yes) {
    if (!interactive) {
      throw new UsageError(
        'setup',
        'Confirm with --yes to change agent settings non-interactively.',
      );
    }
    if (!(await confirm(options.remove ? 'Remove these?' : 'Set these up?', true))) {
      ui.info('Nothing changed.');
      return process.exitCode === 130 ? 130 : 0;
    }
  }
  let failed = false;
  for (const change of changes) {
    let problem: string | null;
    try {
      problem = change.apply();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      failed = true;
      ui.error(change.label, problem);
    } else ui.success(change.label);
  }
  const config = loadConfig();
  await reportMachine(config);
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
