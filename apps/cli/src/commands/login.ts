import process from 'node:process';
import type { PairPollResponse, PairStartResponse } from '@greatping/protocol';
import { api, host } from '../api';
import { type Config, isPaired, loadConfig, requireServer, saveConfig } from '../config';
import { HOST_IDS, inspectHost } from '../integrations';
import { computerName, machinePlatform } from '../machine';
import { renderQr } from '../qr';
import { currentDescription, reportMachine } from '../report';
import {
  color,
  colorEnabled,
  command,
  confirm,
  countdown,
  interactive,
  muted,
  print,
  spinner,
  strong,
  ui,
} from '../ui';
import { setup } from './setup';

export async function login(options: { name?: string }): Promise<number> {
  const config = loadConfig();
  requireServer(config);
  if (isPaired(config)) {
    ui.info(`This computer is already paired ${muted(`(${host(config)})`)}.`);
    ui.next(
      `Run ${command('greatping status')} for details or ${command('greatping logout')} to unpair.`,
    );
    return 0;
  }

  const name = options.name?.trim() || computerName();
  const start = await api<PairStartResponse>(config, 'POST', '/pair/start', {
    token: null,
    body: { machineName: name, platform: machinePlatform(), ...currentDescription() },
  });

  ui.heading('Pair this computer');
  print(`  Open ${strong('GreatPing')} on your phone or tablet and scan this code:`);
  print();
  for (const line of renderQr(start.qrPayload, colorEnabled)) print(`  ${line}`);
  print();
  print(`  Or enter this code in the app:  ${color.bold(color.cyan(start.userCode))}`);
  print();

  const result = await waitForApproval(config, start);
  if (result === 'expired') {
    ui.error('The pairing code expired.', `Run ${command('greatping login')} to get a new one.`);
    return 2;
  }
  if (result === 'cancelled') {
    ui.warn('Pairing cancelled.');
    return 130;
  }

  config.machineId = result.machineId;
  config.machineToken = result.machineToken;
  saveConfig(config);
  const devices = result.deviceCount === 1 ? 'your device' : `your ${result.deviceCount} devices`;
  ui.success(`Paired ${strong(name)}. Alerts now reach ${devices}.`);

  await reportMachine(config);
  const setupResult = await offerSetup();
  if (setupResult !== 0) return setupResult;
  ui.next(`Try it: ${command('greatping notify "Hello from my computer"')}`);
  print();
  return 0;
}

type Approval = Extract<PairPollResponse, { status: 'approved' }> | 'expired' | 'cancelled';

async function waitForApproval(config: Config, start: PairStartResponse): Promise<Approval> {
  const progress = spinner(
    `Waiting for approval ${muted(`· expires in ${countdown(start.expiresAt)}`)}`,
  );
  const ticker = setInterval(
    () =>
      progress.update(
        `Waiting for approval ${muted(`· expires in ${countdown(start.expiresAt)}`)}`,
      ),
    1000,
  );
  let cancelled = false;
  const onInterrupt = () => {
    cancelled = true;
  };
  process.once('SIGINT', onInterrupt);
  try {
    while (!cancelled && Date.now() < start.expiresAt) {
      await sleep(start.pollIntervalSec * 1000, () => cancelled);
      if (cancelled) break;
      try {
        const poll = await api<PairPollResponse>(config, 'GET', `/pair/${start.pairingId}`, {
          token: start.pollSecret,
        });
        if (poll.status === 'approved') return poll;
        if (poll.status === 'expired') return 'expired';
      } catch {
        // Transient network trouble: keep polling until the code expires.
      }
    }
    return cancelled ? 'cancelled' : 'expired';
  } finally {
    clearInterval(ticker);
    progress.stop();
    process.off('SIGINT', onInterrupt);
  }
}

/** Offers to set up agents that are here but not alerting yet. */
async function offerSetup(): Promise<number> {
  const pending = HOST_IDS.map(inspectHost).filter(
    (report) => report.detected && report.hooks.status !== 'ok',
  );
  if (pending.length === 0) return 0;
  const names = pending.map((report) => report.host.name).join(' and ');
  // Never change another tool's settings without asking.
  if (!interactive) {
    ui.next(`Alert your devices when ${names} needs you: ${command('greatping setup')}`);
    return 0;
  }
  return setup(undefined, { skill: true, remove: false, yes: false });
}

export async function logout(options: { yes?: boolean }): Promise<number> {
  const config = loadConfig();
  if (!isPaired(config)) {
    ui.info('This computer is not paired.');
    return 0;
  }
  if (
    !options.yes &&
    !(await confirm('Unpair this computer? It will stop alerting your devices.', true))
  ) {
    ui.info('Still paired.');
    return process.exitCode === 130 ? 130 : 0;
  }
  try {
    await api(config, 'DELETE', '/machine/me', { signal: AbortSignal.timeout(5000) });
  } catch {
    // The local credential is removed either way; the server copy is revoked
    // when reachable, or can be removed in the app.
  }
  saveConfig({ apiUrl: config.apiUrl });
  ui.success('Unpaired. This computer no longer sends alerts.');
  return 0;
}

function sleep(ms: number, stop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (stop() || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}
