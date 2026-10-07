import { spawnSync } from 'node:child_process';
import type { MachineMeResponse } from '@greatping/protocol';
import { api } from '../api';
import { DEFAULT_API_URL, isPaired, loadConfig, pairingProblem } from '../config';
import { ago, clock } from '../duration';
import { detectInstallation } from '../installation';
import { HOST_IDS, type HostReport, inspectHost as readHost, relevant } from '../integrations';
import { installHooks, selectedAlerts } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { registerCodexMcp } from '../integrations/mcp';
import { nativeHost, nativeHostProblem } from '../integrations/native-adapters';
import { pluginCommand } from '../integrations/plugins';
import { AWAY_AFTER_SEC, idleSeconds } from '../integrations/presence';
import { PROBE_EVENT } from '../integrations/runner';
import type { HostId } from '../integrations/state';
import { CommandInterrupted, withProgress } from '../progress';
import { reportMachineWithProgress } from '../report';
import { color, command, muted, print, ui } from '../ui';

type Check = [label: string, value: string];
const inspectHost = (id: HostId) => readHost(id, true);

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
  if (report.lastAlert) {
    const alert = report.lastAlert;
    checks.push([
      'Last alert attempt',
      alert.outcome === 'accepted'
        ? muted(`${ago(alert.at)}: accepted by service; phone delivery unconfirmed`)
        : bad(`${ago(alert.at)}: ${alert.problem}; run greatping doctor after repair`),
    ]);
    if (alert.outcome === 'failed')
      problems.push(`${host.name} last alert failed: ${alert.problem}`);
  }
  if (report.plugin.status !== 'absent') {
    let plugin = report.plugin;
    if (fix && plugin.path && ['unconfigured', 'broken'].includes(plugin.status)) {
      const failure = pluginCommand(host.id, 'configure', currentLauncher());
      if (failure) problems.push(`${host.name} plugin: ${failure}`);
      plugin = inspectHost(host.id).plugin;
    }
    checks.push([
      'Integration',
      muted(`native plugin${plugin.version ? ` ${plugin.version}` : ''}`),
    ]);
    if (nativeHost(host.id)) {
      const issue = nativeHostProblem(host.id);
      if (issue) {
        problems.push(`${host.name}: ${issue}`);
        checks.push(['Host compatibility', bad(issue)]);
      }
    }
    if (plugin.status === 'ready') {
      const failure = pluginCommand(host.id, 'check');
      if (failure) {
        problems.push(`${host.name} plugin check failed`);
        checks.push(['Plugin launcher', bad(failure)]);
      } else
        checks.push([
          'Plugin launcher',
          ok('compatible CLI; components configured; delivery unconfirmed'),
        ]);
      checks.push([
        'Automatic alerts',
        muted(
          host.id === 'codex'
            ? plugin.finished
              ? 'finished turns only; native questions and permissions unsupported'
              : 'off; native questions and permissions unsupported'
            : [...plugin.alerts, ...(plugin.finished ? ['finished responses'] : [])].join(', ') ||
                'off',
        ),
      ]);
    } else if (plugin.status === 'disabled') {
      checks.push(['Plugin', warn('disabled; enable it through the native plugin manager')]);
    } else {
      problems.push(`${host.name} plugin ${plugin.status}`);
      checks.push(['Plugin', bad(plugin.problem ?? plugin.status)]);
    }
    if (report.conflicts.length) {
      problems.push(`${host.name} has duplicate integration components`);
      checks.push([
        'Integration ownership',
        warn(
          `${report.conflicts.join(', ')} — ${host.native ? 'remove duplicate components through their installer' : `greatping setup ${host.id} --migrate`}`,
        ),
      ]);
    }
    checks.push([
      'Hook activation',
      warn(
        host.id === 'codex'
          ? 'trust is managed by Codex; review /hooks and restart the host'
          : host.id === 'claude'
            ? 'restart Claude Code or reconnect MCP; review hooks in the host'
            : host.id === 'cursor'
              ? 'reload Cursor IDE and inspect Customize; local imports must be allowed and a same-name marketplace install takes precedence; Agent CLI unqualified'
              : 'restart the host; extensions remain controlled by its native settings',
      ),
    ]);
    checks.push([
      'Last hook run',
      report.lastHookAt === null
        ? muted('never observed; configuration does not prove delivery')
        : muted(ago(report.lastHookAt)),
    ]);
    return checks;
  }
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
            : [
                ...selectedAlerts(host).map((value) =>
                  value === 'tool-input' ? 'tool input' : value,
                ),
                ...(hooks.finished ? ['finished responses'] : []),
              ].join(', ');
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
    checks.push(['Hook trust', warn('managed by Codex; review /hooks')]);
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

export async function doctor(options: { fix: boolean; verbose?: boolean }): Promise<number> {
  const problems: string[] = [];
  const config = loadConfig();
  ui.heading('Doctor');

  const general: Check[] = [];
  const installation = detectInstallation();
  general.push([
    'Installation',
    muted(
      installation.manager === 'local' || installation.manager === 'unknown'
        ? 'source checkout or external installation'
        : installation.manager,
    ),
  ]);
  if (options.verbose) {
    general.push(['Service address', muted(config.apiUrl)]);
    if (config.apiUrl !== DEFAULT_API_URL)
      general.push(['Expected service', muted(DEFAULT_API_URL)]);
    if (installation.root) general.push(['CLI location', muted(installation.root)]);
    if (installation.launcher) general.push(['CLI launcher', muted(installation.launcher)]);
    if (installation.updateCommand)
      general.push(['Update command', muted(installation.updateCommand)]);
  }
  if (!isPaired(config)) {
    problems.push('not paired');
    general.push(['Pairing', bad(`not paired ${muted(`— ${command('greatping login')}`)}`)]);
  } else if (pairingProblem(config) === 'environment_mismatch') {
    problems.push('pairing belongs to another environment');
    if (!options.verbose) general.push(['Expected service', muted(DEFAULT_API_URL)]);
    general.push(['Pairing', bad('belongs to another environment; alerts cannot use this CLI')]);
    general.push([
      'Repair',
      muted(
        'Use a phone build for the same service, then greatping logout and greatping login. Existing credentials are preserved; doctor --fix cannot migrate pairing.',
      ),
    ]);
  } else {
    try {
      const me = await withProgress('Checking pairing with GreatPing', (signal) =>
        api<MachineMeResponse>(config, 'GET', '/machine/me', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        }),
      );
      general.push(['Pairing', ok(me.machine.name)]);
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
          ? warn('not available yet; alerts are sent at once')
          : muted(
              delay > 0 ? `${delay}s while you are at the computer (change it in the app)` : 'off',
            ),
      ]);
    } catch (error) {
      if (error instanceof CommandInterrupted) throw error;
      problems.push('could not check pairing with GreatPing');
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

  const reports = HOST_IDS.map(inspectHost).filter(relevant);
  for (const report of reports) {
    print();
    print(`  ${color.bold(report.host.name)}`);
    ui.rows(hostChecks(report, options.fix, problems));
  }
  if (reports.length === 0) {
    print();
    ui.info('No supported agent host was found for this user.');
  }
  await reportMachineWithProgress(config);
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
