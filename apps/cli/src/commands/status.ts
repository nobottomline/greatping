import type { MachineMeResponse } from '@greatping/protocol';
import { ApiError, host } from '../api';
import { isPaired, loadConfig } from '../config';
import { clock } from '../duration';
import { HOST_IDS, hostIntegrations, inspectHost } from '../integrations';
import { HOSTS } from '../integrations/host-hooks';
import { readMachine } from '../operations';
import { reportMachine } from '../report';
import { color, command, muted, print, ui } from '../ui';
import { hostSummary } from './setup';

export async function status(options: { json?: boolean }): Promise<number> {
  const config = loadConfig();
  const claudeReport = inspectHost('claude');
  // Kept for scripts written against earlier versions; `integrations` has the detail.
  const claude =
    claudeReport.hooks.status !== 'off'
      ? 'installed'
      : claudeReport.detected
        ? 'not-installed'
        : 'not-detected';
  const integrations = hostIntegrations();

  if (!isPaired(config)) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ paired: false, server: config.apiUrl, claudeHooks: claude, integrations })}\n`,
      );
    } else {
      ui.heading('Status');
      ui.warn('This computer is not paired.');
      ui.next(`Run ${command('greatping login')} to pair it with your GreatPing devices.`);
      print();
    }
    return 1;
  }

  const reported = reportMachine(config);
  let me: MachineMeResponse | null = null;
  let problem: string | null = null;
  try {
    me = await readMachine(config);
  } catch (error) {
    problem = error instanceof Error ? error.message : 'Could not check the pairing.';
    if (error instanceof ApiError && error.status === 401 && options.json) {
      process.stdout.write(
        `${JSON.stringify({ paired: false, revoked: true, server: config.apiUrl })}\n`,
      );
      return 1;
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        paired: true,
        server: config.apiUrl,
        machine: me?.machine ?? { id: config.machineId },
        devices: me?.devices.map((d) => ({ name: d.name, type: d.type, mode: d.mode })) ?? null,
        alertsPausedUntil: me?.machine.alertsPausedUntil ?? null,
        claudeHooks: claude,
        integrations,
        error: problem,
      })}\n`,
    );
    return problem ? 1 : 0;
  }

  await reported;
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
  ui.rows([
    ['Computer', me?.machine.name ?? muted('unknown')],
    ['Devices', devices],
    ['Server', host(config)],
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
