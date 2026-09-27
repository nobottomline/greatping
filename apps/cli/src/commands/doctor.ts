import { spawnSync } from 'node:child_process';
import type { MachineMeResponse } from '@greatping/protocol';
import { api, host as serverHost } from '../api';
import { isPaired, loadConfig } from '../config';
import { ago, clock } from '../duration';
import { HOST_IDS, type HostReport, inspectHost } from '../integrations';
import { installHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp } from '../integrations/mcp';
import { AWAY_AFTER_SEC, idleSeconds } from '../integrations/presence';
import { PROBE_EVENT } from '../integrations/runner';
import { reportMachine } from '../report';
import { color, command, muted, print, ui } from '../ui';

type Check = [label: string, value: string];

const ok = (text: string) => `${color.green('✔')} ${text}`;
const warn = (text: string) => `${color.yellow('▲')} ${text}`;
const bad = (text: string) => `${color.red('✖')} ${text}`;

/** Runs the installed hook command the way the host would, with a no-op event. */
function probe(invocation: { command: string; args: string[] }, id: string): string | null {
  const result = spawnSync(invocation.command, [...invocation.args, 'hook', id], {
    input: JSON.stringify({ hook_event_name: PROBE_EVENT }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) return result.error.message;
  return result.status === 0 ? null : `exited with ${result.status ?? result.signal}`;
}

function hostChecks(report: HostReport, fix: boolean, problems: string[]): Check[] {
  const { host } = report;
  const checks: Check[] = [];
  let hooks = report.hooks;
  if (fix && (hooks.status === 'broken' || hooks.status === 'outdated')) {
    try {
      installHooks(host, currentLauncher(), host.id === 'codex' ? true : hooks.finished);
      hooks = inspectHost(host.id).hooks;
    } catch (error) {
      problems.push(`${host.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  switch (hooks.status) {
    case 'off':
      checks.push(['Alerts', warn(`off ${muted(`— ${command('greatping setup')}`)}`)]);
      break;
    case 'outdated':
      problems.push(`${host.name} hooks are outdated`);
      checks.push([
        'Alerts',
        warn(
          `needs an update: ${hooks.problem} ${muted(`— ${command('greatping doctor --fix')}`)}`,
        ),
      ]);
      break;
    case 'broken':
      problems.push(`${host.name} hooks cannot run`);
      checks.push([
        'Alerts',
        bad(`cannot run: ${hooks.problem} ${muted(`— ${command('greatping doctor --fix')}`)}`),
      ]);
      break;
    case 'ok': {
      const failure = hooks.invocation ? probe(hooks.invocation, host.id) : null;
      if (failure) {
        problems.push(`${host.name} hook failed a test run`);
        checks.push(['Alerts', bad(`test run failed: ${failure}`)]);
      } else {
        const what =
          host.id === 'codex'
            ? 'when a turn finishes'
            : `questions and permissions${hooks.finished ? ', finished turns' : ''}`;
        checks.push(['Alerts', ok(`on ${muted(`(${what})`)}`)]);
      }
      checks.push([
        'Last hook run',
        report.lastHookAt !== null
          ? ok(ago(report.lastHookAt))
          : warn(`never ${muted(`— ${host.activation}`)}`),
      ]);
    }
  }
  if (host.id === 'codex') {
    let mcp = report.mcp;
    if (fix && mcp.registered && mcp.problem) {
      const failure = registerCodexMcp(currentLauncher());
      if (failure) problems.push(`Codex tools: ${failure}`);
      mcp = inspectHost('codex').mcp;
    }
    checks.push([
      'Tools (MCP)',
      !mcp.registered
        ? warn(`not registered ${muted(`— ${command('greatping setup codex')}`)}`)
        : mcp.problem
          ? bad(`cannot start: ${mcp.problem} ${muted(`— ${command('greatping doctor --fix')}`)}`)
          : ok('registered'),
    ]);
    if (mcp.registered && mcp.problem) problems.push('Codex tools cannot start');
  }
  checks.push([
    'Skill',
    report.skill
      ? ok('installed')
      : muted(`not installed — ${command(`greatping setup ${host.id}`)}`),
  ]);
  return checks;
}

export async function doctor(options: { server?: string; fix: boolean }): Promise<number> {
  const problems: string[] = [];
  const config = loadConfig(options.server);
  ui.heading('Doctor');

  const general: Check[] = [];
  if (!isPaired(config)) {
    problems.push('not paired');
    general.push(['Pairing', bad(`not paired ${muted(`— ${command('greatping login')}`)}`)]);
  } else {
    try {
      const me = await api<MachineMeResponse>(config, 'GET', '/machine/me', {
        signal: AbortSignal.timeout(8000),
      });
      general.push(['Pairing', ok(`${me.machine.name} ${muted(`on ${serverHost(config)}`)}`)]);
      general.push([
        'Devices',
        me.devices.some((device) => device.mode === 'first' || device.mode === 'standard')
          ? ok(me.devices.map((device) => device.name).join(', '))
          : warn('no device receives alerts'),
      ]);
      const paused = me.machine.alertsPausedUntil;
      general.push([
        'Alerts',
        paused
          ? warn(`paused until ${clock(paused)} ${muted(`— ${command('greatping resume')}`)}`)
          : ok('active'),
      ]);
      // Servers before migration 0008 know neither the delay nor pausing.
      const delay = me.machine.presenceDelaySec as number | undefined;
      general.push([
        'Presence delay',
        delay === undefined
          ? warn('not supported by this server yet; alerts are sent at once')
          : muted(
              delay > 0 ? `${delay}s while you are at the computer (change it in the app)` : 'off',
            ),
      ]);
    } catch (error) {
      problems.push('server check failed');
      general.push(['Pairing', bad(error instanceof Error ? error.message : String(error))]);
    }
  }
  const idle = idleSeconds();
  general.push([
    'Presence',
    idle === null
      ? muted('not detectable here; attention alerts always wait the presence delay')
      : ok(`detected ${muted(`(idle ${idle}s; away after ${AWAY_AFTER_SEC}s)`)}`),
  ]);
  ui.rows(general);

  const reports = HOST_IDS.map(inspectHost).filter(
    (report) =>
      report.detected || report.hooks.status !== 'off' || report.mcp.registered || report.skill,
  );
  for (const report of reports) {
    print();
    print(`  ${color.bold(report.host.name)}`);
    ui.rows(hostChecks(report, options.fix, problems));
  }
  if (reports.length === 0) {
    print();
    ui.info('Neither Claude Code nor Codex was found for this user.');
  }
  await reportMachine(config);
  print();
  if (problems.length > 0) {
    ui.error(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
      options.fix
        ? undefined
        : `Run ${command('greatping doctor --fix')} to repair what can be repaired.`,
    );
    print();
    return 1;
  }
  ui.success('Everything looks good.');
  print();
  return 0;
}
