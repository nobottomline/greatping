import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineMeResponse, ProjectLabels } from '@greatping/protocol';
import { z } from 'zod';
import { api } from '../api';
import { configDir, isPaired, loadConfig } from '../config';
import { cachedProjectLabels } from '../identity';
import { type HostReport, inspectHost } from '../integrations';
import { CLAUDE_ALERTS, type ClaudeAlert } from '../integrations/events';
import { HOSTS, installHooks, selectedAlerts, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp, unregisterCodexMcp } from '../integrations/mcp';
import {
  adapterAlerts,
  bundledAdapterVersion,
  installNativeAdapter,
  nativeHost,
  nativeHostProblem,
} from '../integrations/native-adapters';
import { pluginCommand } from '../integrations/plugins';
import {
  bundledSkill,
  installSkill,
  type SkillState,
  skillDir,
  skillState,
  uninstallSkill,
} from '../integrations/skill';
import {
  home,
  keptAsIs,
  rememberSkillChoices,
  runSkillsInstaller,
  skillDeclined,
} from '../integrations/skills-cli';
import type { HostId } from '../integrations/state';
import { CommandInterrupted, withProgress } from '../progress';
import { reportMachineWithProgress } from '../report';
import { menu, type PickerItem, pickSetup } from '../setup-picker';
import { color, command, muted, print, ui } from '../ui';
import { setProjectLabels } from './project';

/**
 * Interactive `greatping setup`: detect, show one plan, apply it, summarize.
 * Nothing on disk changes before the plan is applied, so Escape, Ctrl+C or
 * Cancel at any point before that leave every setting as it was.
 */

type Kind = 'direct' | 'plugin' | 'adapter';

export interface Agent {
  id: HostId;
  name: string;
  kind: Kind;
  /** Unselected agents are left unchanged, including existing integrations. */
  selected: boolean;
  report: HostReport;
  /** Why setup cannot change this agent; shown in the plan, never applied. */
  blocked: string | null;
  /** A problem that leaves part of this agent as it is, e.g. an unreadable skill state. */
  warning: string | null;
  alerts: ClaudeAlert[];
  finished: boolean;
  /** Direct Codex: GreatPing tools over MCP. */
  mcp: boolean;
  /** Direct hosts: whether the bundled skill should be installed. */
  skill: boolean;
  /** Direct hosts: the skill's state, or null when setup leaves skills alone. */
  skillState: SkillState | null;
}

interface Plan {
  agents: Agent[];
  /** Null when the computer is not paired: the setting lives on the server. */
  labels: { current: ProjectLabels; wanted: ProjectLabels } | null;
  npx: boolean;
  /** Whether the skill rows (bundled and npx) are offered. */
  skills: boolean;
}

interface Step {
  label: string;
  run(): string | null;
}

export interface FlowOptions {
  finished?: boolean;
  skill: boolean;
}

const ALERT_WORDS: Record<ClaudeAlert | 'finished', string> = {
  questions: 'questions',
  permissions: 'permissions',
  'tool-input': 'tool input',
  finished: 'finished turns',
};

const ALERT_HINTS: Record<ClaudeAlert, string> = {
  questions: 'Alert when Claude asks you a question.',
  permissions: 'Alert when Claude asks you to approve an action.',
  'tool-input': 'Alert when a connected tool asks for your input.',
};

// Choices for directly set-up hosts are remembered while their alerts are off.
const selectionSchema = z.object({
  alerts: z.array(z.enum(CLAUDE_ALERTS)),
  finished: z.boolean(),
  mcp: z.boolean(),
});
type Selection = z.infer<typeof selectionSchema>;
const optionsFile = () => join(configDir(), 'setup-options.json');

function savedOptions(): Record<string, unknown> {
  try {
    const saved = JSON.parse(readFileSync(optionsFile(), 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function rememberSelections(agents: Agent[]): void {
  const saved = savedOptions();
  for (const agent of agents) {
    if (agent.kind !== 'direct') continue;
    const previous = saved[agent.id];
    saved[agent.id] = {
      ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
      alerts: agent.alerts,
      finished: agent.finished,
      mcp: agent.mcp,
    };
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(optionsFile(), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
}

function directAgent(report: HostReport, options: FlowOptions, content: string | null): Agent {
  const id = report.host.id;
  const parsed = selectionSchema.safeParse(savedOptions()[id]);
  const previous: Selection | undefined = parsed.success ? parsed.data : undefined;
  const on = report.hooks.status !== 'off';
  const fresh = !on && !report.skill && !report.mcp.registered && !previous;
  let state: SkillState | null = null;
  let warning: string | null = null;
  if (options.skill && content !== null) {
    try {
      state = skillState(id, content);
    } catch {
      // Never show parser output: these files belong to other tools.
      warning = `The skill state at ${home(skillDir(id))} or of npx skills cannot be read; the skill is left as it is.`;
    }
  }
  const offered = state !== null && keptAsIs(id, state) === null;
  return {
    id,
    name: report.host.name,
    kind: 'direct',
    selected: true,
    report,
    blocked: null,
    warning,
    alerts: on ? selectedAlerts(HOSTS[id]) : (previous?.alerts ?? [...CLAUDE_ALERTS]),
    finished:
      options.finished ??
      (on ? report.hooks.finished : (previous?.finished ?? (id === 'codex' && fresh))),
    mcp: id === 'codex' && (report.mcp.registered || fresh),
    // Offered until the user turns it off once.
    skill: offered && (state !== 'absent' || !skillDeclined(id)),
    skillState: state,
  };
}

function packagedAgent(report: HostReport, options: FlowOptions): Agent {
  const id = report.host.id;
  const plugin = report.plugin;
  const adapter = nativeHost(id);
  let blocked: string | null = null;
  if (adapter) {
    blocked = nativeHostProblem(id);
    if (!blocked && plugin.status === 'unknown') blocked = plugin.problem;
  } else if (plugin.status === 'disabled' || plugin.status === 'unknown' || !plugin.path) {
    blocked =
      plugin.status === 'disabled'
        ? 'The GreatPing plugin is disabled; enable it in the agent’s plugin manager.'
        : (plugin.problem ?? 'The GreatPing plugin cannot be verified.');
  }
  if (!blocked && report.conflicts.length)
    blocked = adapter
      ? 'A separate GreatPing skill conflicts with this adapter. Remove it through its installer first.'
      : `An older direct integration is still active. Run greatping setup ${id} --migrate to keep one integration owner.`;
  const configured = plugin.status === 'ready' || plugin.status === 'broken';
  return {
    id,
    name: report.host.name,
    kind: adapter ? 'adapter' : 'plugin',
    selected: true,
    report,
    blocked,
    warning: null,
    alerts: adapter
      ? adapterAlerts(id)
      : id === 'codex'
        ? []
        : plugin.status === 'ready'
          ? plugin.alerts
          : [...CLAUDE_ALERTS],
    // Plugins and adapters alert on finished turns by default, except Claude
    // Code, whose earlier direct hooks decide (as the plugin bridge does).
    finished:
      options.finished ?? (configured ? plugin.finished : id !== 'claude' || report.hooks.finished),
    mcp: false,
    skill: false,
    skillState: null,
  };
}

/** Whether an adapter's files need to be (re)installed from this CLI. */
function adapterOutdated(agent: Agent): boolean {
  const plugin = agent.report.plugin;
  return (
    nativeHost(agent.id) &&
    (plugin.status !== 'ready' || plugin.version !== bundledAdapterVersion(agent.id))
  );
}

function configurePackage(agent: Agent): string | null {
  const configured = pluginCommand(agent.id, 'configure', currentLauncher(), agent.finished);
  if (configured) return configured;
  const checked = pluginCommand(agent.id, 'check');
  if (checked && agent.report.conflicts.length && agent.kind === 'plugin')
    return `${checked} Migrate the older direct setup with greatping setup ${agent.id} --migrate.`;
  return checked;
}

/** The changes applying the plan makes for one agent, in order. */
export function steps(agent: Agent, content: string | null): Step[] {
  const { id, name, report } = agent;
  if (!agent.selected || agent.blocked) return [];
  if (agent.kind !== 'direct') {
    const files = adapterOutdated(agent);
    if (!files && report.plugin.status === 'ready' && report.plugin.finished === agent.finished)
      return [];
    const label =
      agent.kind === 'plugin'
        ? `${name}: configure the plugin`
        : report.plugin.status === 'absent'
          ? `${name}: install the adapter`
          : `${name}: update the adapter`;
    return [
      {
        label,
        run: () => {
          if (files && nativeHost(id)) installNativeAdapter(id);
          return configurePackage(agent);
        },
      },
    ];
  }
  const host = HOSTS[id];
  const list: Step[] = [];
  const enabled = id === 'codex' ? agent.finished : agent.finished || agent.alerts.length > 0;
  const sameAlerts = id === 'codex' || selectedAlerts(host).join(',') === agent.alerts.join(',');
  if (
    enabled &&
    (report.hooks.status !== 'ok' || report.hooks.finished !== agent.finished || !sameAlerts)
  )
    list.push({
      label: `${name}: ${report.hooks.status === 'off' ? 'turn on' : 'update'} alerts`,
      run: () => {
        installHooks(host, currentLauncher(), agent.finished, agent.alerts);
        return null;
      },
    });
  else if (!enabled && report.hooks.status !== 'off')
    list.push({
      label: `${name}: turn off alerts`,
      run: () => {
        uninstallHooks(host);
        return null;
      },
    });
  if (id === 'codex') {
    if (agent.mcp && (!report.mcp.registered || report.mcp.problem))
      list.push({
        label: 'Codex: add GreatPing tools',
        run: () => registerCodexMcp(currentLauncher()),
      });
    else if (!agent.mcp && report.mcp.registered)
      list.push({
        label: 'Codex: remove GreatPing tools',
        run: () => (unregisterCodexMcp() ? null : 'Could not remove the Codex tools.'),
      });
  }
  const state = agent.skillState;
  if (content !== null && state !== null && keptAsIs(id, state) === null) {
    const where = home(skillDir(id));
    if (agent.skill && state !== 'current')
      list.push({
        label: `${name}: ${state === 'outdated' ? 'update' : 'install'} the skill in ${where}`,
        run: () => {
          installSkill(id, content);
          return null;
        },
      });
    else if (!agent.skill && state !== 'absent')
      list.push({
        label: `${name}: remove the skill from ${where}`,
        run: () => (uninstallSkill(id) ? null : 'The skill was not removed.'),
      });
  }
  return list;
}

const capitalized = (text: string) => (text[0]?.toUpperCase() ?? '') + text.slice(1);

/** "Questions, permissions · tools · skill" */
function describe(agent: Agent): string {
  // Codex has only one alert: its turn finished.
  const alerts: string[] = (agent.id === 'codex' ? [] : agent.alerts).map((a) => ALERT_WORDS[a]);
  if (agent.finished) alerts.push(ALERT_WORDS.finished);
  const parts = [alerts.length ? capitalized(alerts.join(', ')) : 'No alerts'];
  // A plugin brings its own tools and skill; its version says which.
  if (agent.kind !== 'direct') parts.push('tools', 'skill');
  else {
    if (agent.mcp) parts.push('tools');
    const state = agent.skillState;
    if (agent.skill) parts.push(state === 'outdated' ? 'skill update' : 'skill');
    else if (state === 'managed') parts.push('skill via npx skills');
    else if (state === 'modified' || state === 'external') parts.push('skill kept as is');
  }
  return parts.join(muted(' · '));
}

type Mark = 'new' | 'change' | 'off' | 'same' | 'skip' | 'blocked';

// Terraform-style plan marks; the legend lists only the marks in use.
const MARKS: Record<Mark, [symbol: string, legend: string]> = {
  new: [color.green('+'), 'set up'],
  change: [color.yellow('~'), 'change'],
  off: [color.yellow('−'), 'turn off'],
  same: [muted('✔'), 'no change'],
  skip: [muted('○'), 'skipped'],
  blocked: [color.red('✖'), 'needs attention'],
};

function mark(agent: Agent, pending: number): Mark {
  if (!agent.selected) return 'skip';
  if (agent.blocked) return 'blocked';
  if (!pending) return 'same';
  const report = agent.report;
  if (agent.kind !== 'direct')
    return ['absent', 'unconfigured'].includes(report.plugin.status) ? 'new' : 'change';
  const fresh =
    report.hooks.status === 'off' &&
    !report.mcp.registered &&
    (agent.skillState === null || agent.skillState === 'absent');
  if (fresh) return 'new';
  const off =
    (agent.id === 'codex' ? !agent.finished : !agent.finished && !agent.alerts.length) &&
    !agent.mcp &&
    !agent.skill;
  return off ? 'off' : 'change';
}

/** The plan is navigable: every agent can be inspected, even in a short terminal. */
function reviewActions(plan: Plan, content: string | null) {
  const pending =
    plan.agents.reduce((count, agent) => count + steps(agent, content).length, 0) +
    Number(Boolean(plan.labels && plan.labels.current !== plan.labels.wanted)) +
    Number(plan.npx);
  const actions = [
    {
      value: pending ? 'apply' : 'done',
      label: pending ? `Apply ${pending} change${pending === 1 ? '' : 's'}` : 'Done',
      hint: pending ? 'Save the reviewed configuration' : 'Keep these settings',
    },
  ];
  for (const agent of plan.agents) {
    const key = mark(agent, steps(agent, content).length);
    actions.push({
      value: agent.id,
      label: `${MARKS[key][0]} ${agent.name} · ${!agent.selected ? 'keep current settings' : agent.blocked ? 'needs attention' : describe(agent)}`,
      hint: !agent.selected
        ? 'Keep the current configuration'
        : (agent.blocked ?? agent.warning ?? `${MARKS[key][1]} · Enter to customize`),
    });
  }
  actions.push({
    value: 'agents',
    label: 'Choose agents',
    hint: 'Leave unselected agents unchanged',
  });
  if (plan.labels)
    actions.push({
      value: 'projects',
      label: 'Project names',
      hint:
        plan.labels.wanted === 'folder'
          ? 'Show repository folder names in alerts'
          : 'Project names hidden',
    });
  if (plan.skills)
    actions.push({
      value: 'skills',
      label: 'Other agents',
      hint: plan.npx
        ? 'Install the skill with npx skills'
        : 'Optional skill installation through npx skills',
    });
  actions.push({ value: 'cancel', label: 'Cancel', hint: 'Change nothing' });
  return { actions, pending };
}

async function chooseAgents(plan: Plan): Promise<boolean> {
  const selected = await pickSetup(
    plan.agents.map((agent) => ({
      id: agent.id,
      label: agent.name,
      hint:
        agent.blocked ??
        (agent.report.plugin.status === 'absent' && agent.report.hooks.status === 'off'
          ? 'Available to configure'
          : 'Existing integration'),
      selected: agent.selected,
    })),
    'Choose agents',
  );
  if (!selected) return false;
  for (const agent of plan.agents) agent.selected = selected.has(agent.id);
  return true;
}

function customizeItems(plan: Plan, scope: string): PickerItem[] {
  const items: PickerItem[] = [];
  for (const agent of plan.agents) {
    if (agent.id !== scope || !agent.selected || agent.blocked) continue;
    const { id, name } = agent;
    const add = (key: string, label: string, hint: string, selected: boolean) =>
      items.push({ id: `${id}:${key}`, label, hint, selected });
    if (agent.kind === 'direct' && id === 'claude')
      for (const alert of CLAUDE_ALERTS)
        add(
          alert,
          capitalized(ALERT_WORDS[alert]),
          ALERT_HINTS[alert],
          agent.alerts.includes(alert),
        );
    add(
      'finished',
      'Finished turns',
      `Alert when ${name} finishes a turn and waits for you.`,
      agent.finished,
    );
    if (agent.kind === 'direct' && id === 'codex')
      add(
        'mcp',
        'Agent tools',
        'Let Codex send a ping or ask a question through GreatPing.',
        agent.mcp,
      );
    if (agent.kind === 'direct' && agent.skillState && keptAsIs(id, agent.skillState) === null)
      add(
        'skill',
        `Skill${agent.skillState === 'outdated' ? ' · update available' : ''}`,
        `Lets ${name} use GreatPing when you ask: “ping me when the deploy is done”. Installed in ${home(skillDir(id))}${id === 'codex' ? ', also read by other agents' : ''}.`,
        agent.skill,
      );
  }
  if (scope === 'projects' && plan.labels)
    items.push({
      id: 'projects:labels',
      label: 'Show project folder names',
      hint: 'Alerts name the git repository folder, e.g. "Codex · billing-api". Rename or hide a project with greatping project.',
      selected: plan.labels.wanted === 'folder',
    });
  if (scope === 'skills' && plan.skills)
    items.push({
      id: 'skills:npx',
      label: 'Install the skill with npx skills',
      hint: 'Downloads skills@1.7.0 from npm and opens its installer for any agent it supports.',
      selected: plan.npx,
    });
  return items;
}

function applyChoices(plan: Plan, selected: Set<string>, scope: string): void {
  for (const agent of plan.agents) {
    if (agent.id !== scope || !agent.selected || agent.blocked) continue;
    const has = (key: string) => selected.has(`${agent.id}:${key}`);
    if (agent.kind === 'direct' && agent.id === 'claude') agent.alerts = CLAUDE_ALERTS.filter(has);
    agent.finished = has('finished');
    if (agent.kind === 'direct' && agent.id === 'codex') agent.mcp = has('mcp');
    if (
      agent.kind === 'direct' &&
      agent.skillState &&
      keptAsIs(agent.id, agent.skillState) === null
    )
      agent.skill = has('skill');
  }
  if (scope === 'projects' && plan.labels)
    plan.labels.wanted = selected.has('projects:labels') ? 'folder' : 'hidden';
  if (scope === 'skills') plan.npx = selected.has('skills:npx');
}

const cancelled = () => {
  if (!process.exitCode) {
    ui.info('Setup cancelled. Nothing changed.');
    print();
  }
  return Number(process.exitCode ?? 0);
};

/** What to do after the changes, once per kind of action. */
function nextSteps(changed: Agent[], paired: boolean): string[] {
  const lines: string[] = [];
  const restart = changed.filter((agent) => agent.id !== 'cursor').map((agent) => agent.name);
  if (restart.length)
    lines.push(
      `Restart ${restart.join(', ').replace(/, ([^,]*)$/, ' and $1')} to load the new settings.`,
    );
  if (changed.some((agent) => agent.id === 'cursor'))
    lines.push('Reload Cursor IDE; allow local plugin imports in Customize if asked.');
  if (changed.some((agent) => agent.id === 'codex' && agent.finished))
    lines.push(`In Codex, open ${command('/hooks')} and trust the GreatPing hooks if asked.`);
  if (!paired) lines.push(`Pair this computer with your phone: ${command('greatping login')}`);
  return lines;
}

/** Each agent with the choices setup would apply; reads settings, changes nothing. */
export function detectAgents(
  ids: HostId[],
  options: FlowOptions,
  includeMissing = true,
): { agents: Agent[]; content: string | null } {
  let content: string | null = null;
  try {
    content = bundledSkill();
  } catch {}
  const agents = ids.flatMap((id) => {
    const report = inspectHost(id, true);
    if (!includeMissing && !report.detected && report.plugin.status === 'absent') return [];
    return [
      nativeHost(id) || report.plugin.status !== 'absent'
        ? packagedAgent(report, options)
        : directAgent(report, options, content),
    ];
  });
  return { agents, content };
}

export async function interactiveSetup(
  ids: HostId[],
  options: FlowOptions,
  selectAgents = true,
): Promise<number> {
  ui.heading('Set up your agents');
  const config = loadConfig();
  const paired = isPaired(config);
  let labels = paired ? cachedProjectLabels() : null;
  const { agents, content } = await withProgress(
    'Looking for agents',
    async (signal) => {
      // A settings preview may read the server but must not report, drain
      // project commands, advance a manifest or write local caches.
      if (paired) {
        try {
          const me = await api<MachineMeResponse>(config, 'GET', '/machine/me', {
            signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
            updateLocalSettings: false,
          });
          const mode = me.machine.projectLabels;
          if (mode === 'folder' || mode === 'hidden') labels = mode;
        } catch {
          /* Keep cached labels when the service is unavailable. */
        }
        signal.throwIfAborted();
      }
      return detectAgents(ids, options, !selectAgents);
    },
    { interrupted: 'Setup cancelled. Nothing changed.' },
  );
  if (!agents.length) {
    ui.info('No supported agent was found for this user.');
    ui.next(`Install one, then run ${command('greatping setup')} again.`);
    print();
    return 0;
  }
  const plan: Plan = {
    agents,
    labels: labels ? { current: labels, wanted: labels } : null,
    npx: false,
    skills: options.skill && content !== null,
  };

  if (selectAgents && !(await chooseAgents(plan))) return cancelled();
  for (;;) {
    const { actions, pending } = reviewActions(plan, content);
    const attention = plan.agents.some(
      (agent) => agent.selected && (agent.blocked || agent.warning),
    );
    const action = await menu(
      pending
        ? 'Review setup'
        : attention
          ? 'Review setup · Some agents need attention'
          : 'Review setup · No changes needed',
      actions,
    );
    if (action === null || action === 'cancel') return cancelled();
    if (action === 'done') return attention ? 1 : 0;
    if (action === 'apply') break;
    if (action === 'agents') {
      if (!(await chooseAgents(plan)) && process.exitCode) return cancelled();
      continue;
    }
    const agent = plan.agents.find((item) => item.id === action);
    if (agent && !agent.selected) {
      ui.info(`${agent.name} is left unchanged. Select it in Choose agents to configure it.`);
      continue;
    }
    if (agent?.blocked) {
      ui.warn(`${agent.name}: ${agent.blocked}`);
      continue;
    }
    if (agent?.kind !== 'direct' && agent) {
      ui.info(
        `${agent.name}: ${describe(agent)}. Tools and skill are included in this integration.`,
      );
      if (agent.id === 'codex')
        ui.info(
          'Codex automatically alerts on finished responses; native questions and approvals are not covered.',
        );
    }
    const selected = await pickSetup(
      customizeItems(plan, action),
      agent ? `${agent.name} settings` : action === 'projects' ? 'Project names' : 'Other agents',
    );
    if (selected === null && process.exitCode) return cancelled();
    if (selected) applyChoices(plan, selected, action);
  }

  let failed = false;
  const run = async (
    label: string,
    work: (signal: AbortSignal) => Promise<string | null> | string | null,
  ) => {
    let problem: string | null;
    try {
      problem = await withProgress(label, async (signal) => work(signal), {
        interrupted:
          'Setup interrupted. Some changes may already be applied; run greatping doctor.',
      });
    } catch (error) {
      if (error instanceof CommandInterrupted) throw error;
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      failed = true;
      ui.error(label, problem);
    } else ui.success(label);
    return !problem;
  };
  const changed: Agent[] = [];
  for (const agent of plan.agents) {
    let ok = true;
    const list = steps(agent, content);
    for (const step of list) ok = (await run(step.label, () => step.run())) && ok;
    if (list.length && ok) changed.push(agent);
  }
  const saved = plan.agents.filter(
    (agent) =>
      agent.selected &&
      !agent.blocked &&
      (!steps(agent, content).length || changed.includes(agent)),
  );
  rememberSelections(saved);
  rememberSkillChoices(
    new Map(
      saved
        .filter(
          (agent) => agent.skillState !== null && keptAsIs(agent.id, agent.skillState) === null,
        )
        .map((agent) => [agent.id, agent.skill]),
    ),
  );
  const wanted = plan.labels?.wanted;
  if (wanted && wanted !== plan.labels?.current)
    await run(
      `Projects: ${wanted === 'folder' ? 'show folder names' : 'hide names'} in alerts`,
      async (signal) => {
        await setProjectLabels(wanted, signal);
        return null;
      },
    );
  let code = 0;
  if (plan.npx) {
    print();
    code = await runSkillsInstaller();
    print();
  }
  await reportMachineWithProgress(loadConfig());

  print();
  const blocked = plan.agents.filter((agent) => agent.selected && (agent.blocked || agent.warning));
  if (failed || code)
    ui.error('Some changes were not applied.', 'Run greatping doctor for details.');
  else if (blocked.length)
    ui.warn(`${blocked.map((agent) => agent.name).join(', ')} still needs attention (see above).`);
  else ui.success('Configuration saved.');
  const next = nextSteps(changed, isPaired(loadConfig()));
  if (next.length) {
    print();
    for (const line of next) ui.next(line);
  }
  print();
  return failed || blocked.length ? 1 : code || Number(process.exitCode ?? 0);
}
