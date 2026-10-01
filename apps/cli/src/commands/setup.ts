import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir, isPaired, loadConfig } from '../config';
import { HOST_IDS, inspectHost } from '../integrations';
import { CLAUDE_ALERTS, type ClaudeAlert } from '../integrations/events';
import { HOSTS, installHooks, selectedAlerts, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp, unregisterCodexMcp } from '../integrations/mcp';
import { executeRemoval, integrationRemoval } from '../integrations/removal';
import { installSkill } from '../integrations/skill';
import { setupSkills } from '../integrations/skills-cli';
import type { HostId } from '../integrations/state';
import { reportMachine } from '../report';
import { type PickerItem, pickSetup } from '../setup-picker';
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
  if (options.remove) {
    const changes = integrationRemoval(only ? [only] : HOST_IDS);
    ui.heading('Remove agent setup');
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
    const results = await executeRemoval(changes);
    for (const result of results) {
      if (result.status === 'failed') ui.error(result.label, result.error);
      else ui.success(result.label);
    }
    await reportMachine(loadConfig());
    return results.some((result) => result.status === 'failed') ? 1 : 0;
  }
  const ids = only ? [only] : HOST_IDS.filter((id) => inspectHost(id).detected || options.remove);
  ui.heading(options.remove ? 'Remove agent setup' : 'Set up your agents');
  if (ids.length === 0) {
    ui.info('Neither Claude Code nor Codex was found for this user.');
    ui.next(`Install one, then run ${command('greatping setup')} again.`);
    print();
    return 0;
  }
  let selections: Map<HostId, Selection> | null = null;
  if (interactive && !options.yes && !options.remove) {
    print(`  ${muted('Choose which alerts reach your devices.')}`);
    print();
    selections = new Map(ids.map((id) => [id, initialSelection(id, options)]));
    const selected = await pickSetup(pickerItems(ids, selections));
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
  }
  const changes = ids.flatMap((id) => {
    const selection = selections?.get(id);
    return selection ? selectedChanges(id, selection) : changesFor(id, options);
  });
  if (changes.length === 0) {
    if (selections) rememberSelections(selections);
    ui.info('Settings are already up to date.');
    print();
    return selections && options.skill ? setupSkills(only) : 0;
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
      problem = change.apply();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      failed = true;
      ui.error(change.label, problem);
    } else if (!selections) ui.success(change.label);
  }
  const config = loadConfig();
  await reportMachine(config);
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
    return options.skill ? setupSkills(only) : 0;
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
