import type { MachineMeResponse } from '@greatping/protocol';
import { ApiError } from '../api';
import { type Config, isPaired, loadConfig, pairingProblem } from '../config';
import { clock } from '../duration';
import {
  HOST_IDS,
  hostIntegrations,
  inspectHost,
  pluginDiagnostics,
  toHostIntegration,
} from '../integrations';
import { HOSTS } from '../integrations/host-hooks';
import { readMachine } from '../operations';
import { reportMachine } from '../report';
import { color, command, muted, print, spinner, ui } from '../ui';
import { hostSummary } from './setup';

export async function status(options: { json?: boolean }): Promise<number> {
  const config = loadConfig();
  const claudeReport = inspectHost('claude', true);
  // Kept for scripts written against earlier versions; `integrations` has the detail.
  const claude =
    toHostIntegration(claudeReport).hooks !== 'off'
      ? 'installed'
      : claudeReport.detected
        ? 'not-installed'
        : 'not-detected';
  const integrations = hostIntegrations(true);
  const plugins = pluginDiagnostics(true);

  if (!isPaired(config)) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ paired: false, server: config.apiUrl, pairingProblem: pairingProblem(config), claudeHooks: claude, integrations, plugins })}\n`,
      );
    } else {
      ui.heading('Status');
      ui.warn('This computer is not paired.');
      ui.next(`Run ${command('greatping login')} to pair it with your GreatPing devices.`);
      print();
    }
    return 1;
  }

  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const progress = options.json ? undefined : spinner('Checking status in GreatPing');
  let me: MachineMeResponse | null = null;
  let problem: string | null = null;
  let revoked = false;
  try {
    const reported = reportMachine(config, controller.signal);
    try {
      me = await readMachine(config, controller.signal);
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Could not check the pairing.';
      revoked = error instanceof ApiError && error.status === 401;
    }
    await reported;
  } finally {
    progress?.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  if (exitCode) {
    if (!options.json) ui.warn('Status check interrupted.');
    return exitCode;
  }
  if (revoked && options.json) {
    process.stdout.write(
      `${JSON.stringify({ paired: false, revoked: true, server: config.apiUrl })}\n`,
    );
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        paired: true,
        pairingProblem: pairingProblem(config),
        server: config.apiUrl,
        machine: me?.machine ?? { id: config.machineId },
        devices: me?.devices.map((d) => ({ name: d.name, type: d.type, mode: d.mode })) ?? null,
        alertsPausedUntil: me?.machine.alertsPausedUntil ?? null,
        claudeHooks: claude,
        integrations,
        plugins,
        keys: config.keys && config.manifest ? { manifestVersion: config.manifest.version } : null,
        // Questions, messages, project names and answers are sealed end to end.
        encryption: config.keys && config.manifest ? 'end-to-end' : null,
        error: problem,
      })}\n`,
    );
    return problem ? 1 : 0;
  }

  ui.heading('Status');
  const label = { first: 'alerted first', standard: '', backup: 'reminders only', off: 'off' };
  const devices = me
    ? me.devices
        .map((d) => (label[d.mode] ? `${d.name} ${muted(`(${label[d.mode]})`)}` : d.name))
        .join(', ') || muted('none')
    : muted('unknown');
  const paused = me?.machine.alertsPausedUntil ?? null;
  const hostRows = HOST_IDS.flatMap((id): Array<[string, string]> => {
    const summary = hostSummary(id);
    return summary ? [[HOSTS[id].name, summary]] : [];
  });
  const reloaded = loadConfig();
  ui.rows([
    ['Computer', me?.machine.name ?? muted('unknown')],
    ['Devices', devices],
    ['Keys', keysSummary(reloaded)],
    ...(paused
      ? [
          [
            'Alerts',
            `${color.yellow(`paused until ${clock(paused)}`)} ${muted('— greatping resume')}`,
          ] as [string, string],
        ]
      : []),
    ...(hostRows.length > 0 ? hostRows : [['Agents', muted('none found')] as [string, string]]),
  ]);
  print();
  if (problem) {
    ui.error(
      problem,
      problem.includes('no longer paired')
        ? 'Run greatping logout, then greatping login.'
        : undefined,
    );
    print();
    return 1;
  }
  return 0;
}

/** Whether this computer holds keys its devices vouched for (docs/device-keys.md). */
function keysSummary(config: Config): string {
  if (!config.keys || !config.manifest)
    return `${color.yellow('none')} ${muted('— paired before keys; greatping logout, then greatping login')}`;
  return `verified, alerts end-to-end encrypted ${muted(`(account manifest v${config.manifest.version})`)}`;
}
