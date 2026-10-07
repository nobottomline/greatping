import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildPairDeepLink,
  type PairPollResponse,
  type PairStartResponse,
} from '@greatping/protocol';
import {
  joinUserCode,
  type Manifest,
  newCodeHalf,
  startCeremony,
  toBase64Url,
} from '@greatping/protocol/crypto';
import { api } from '../api';
import { type Config, isPaired, loadConfig, requireServer, saveConfig } from '../config';
import { HOST_IDS, inspectHost } from '../integrations';
import { newMachineKeys, randomBytes, verifyPairing } from '../keys';
import { computerName, machinePlatform } from '../machine';
import { withProgress } from '../progress';
import { renderQr } from '../qr';
import { currentDescription, reportMachineWithProgress } from '../report';
import {
  color,
  colorEnabled,
  command,
  confirm,
  countdown,
  interactive,
  muted,
  print,
  strong,
  ui,
} from '../ui';
import { setup } from './setup';

export async function login(options: { name?: string }): Promise<number> {
  const config = loadConfig();
  requireServer(config);
  if (isPaired(config)) {
    ui.info('This computer is already paired with GreatPing.');
    ui.next(
      `Run ${command('greatping status')} for details or ${command('greatping logout')} to unpair.`,
    );
    return 0;
  }

  const name = options.name?.trim() || computerName();
  // The code's second half is this computer's secret: it is shown here and
  // typed or scanned on the phone, and never sent to the server. CPace on it
  // lets the computer and the phone confirm each other's keys
  // (docs/device-keys.md).
  const keys = newMachineKeys();
  const secret = newCodeHalf(randomBytes);
  const session = toBase64Url(randomBytes(16));
  const state = startCeremony({
    kind: 'pair',
    sessionId: session,
    secret,
    keys: keys.public,
    random: randomBytes,
  });
  const start = await withProgress(
    'Creating a pairing code in GreatPing',
    (signal) =>
      api<PairStartResponse>(config, 'POST', '/pair/start', {
        token: null,
        body: {
          machineName: name,
          platform: machinePlatform(),
          ...currentDescription(),
          keys: keys.public,
          session,
          share: state.share,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      }),
    { interrupted: 'Pairing-code request interrupted. Run greatping login to start again.' },
  );
  const code = joinUserCode(start.lookup, secret);

  ui.heading('Pair this computer');
  print(`  Open ${strong('GreatPing')} on your phone or tablet and scan this code:`);
  print();
  for (const line of renderQr(buildPairDeepLink(code), colorEnabled)) print(`  ${line}`);
  print();
  print(`  Or enter this code in the app:  ${color.bold(color.cyan(code))}`);
  print();

  const result = await waitForApproval(config, start);
  if (result === 'expired') {
    ui.error('The pairing code expired.', `Run ${command('greatping login')} to get a new one.`);
    return 2;
  }

  const paired: Config = {
    ...config,
    machineId: result.machineId,
    machineToken: result.machineToken,
  };
  let verified: { tag: string; manifest: Manifest };
  try {
    verified = verifyPairing({
      state,
      ceremony: result.ceremony,
      manifests: result.manifests as Manifest[],
      accountId: result.accountId,
      machineId: result.machineId,
      keys: keys.public,
    });
  } catch {
    // A mistyped code, or someone in between: never keep this pairing.
    await api(paired, 'DELETE', '/machine/me', { signal: AbortSignal.timeout(5000) }).catch(
      () => {},
    );
    ui.error(
      'The code did not match, so this computer was not paired.',
      `Check the code and run ${command('greatping login')} again.`,
    );
    return 2;
  }
  Object.assign(config, paired, { keys: keys.secret, manifest: verified.manifest });
  saveConfig(config);
  // The phone checks this tag to trust the computer's keys in turn.
  await withProgress(
    'Confirming pairing with GreatPing',
    (signal) =>
      api(config, 'POST', '/machine/me/ceremony', {
        body: { tag: verified.tag },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      }).catch(() => {}),
    {
      interrupted:
        'Pairing confirmation interrupted. Pairing was saved locally; run greatping status.',
    },
  );
  const devices = result.deviceCount === 1 ? 'your device' : `your ${result.deviceCount} devices`;
  ui.success(`Paired ${strong(name)}. Alerts now reach ${devices}.`);

  await reportMachineWithProgress(config);
  const setupResult = await offerSetup();
  if (setupResult !== 0) return setupResult;
  ui.next(`Try it: ${command('greatping notify "Hello from my computer"')}`);
  print();
  return 0;
}

type Approval = Extract<PairPollResponse, { status: 'approved' }> | 'expired';

async function waitForApproval(config: Config, start: PairStartResponse): Promise<Approval> {
  const label = () => `Waiting for approval ${muted(`· expires in ${countdown(start.expiresAt)}`)}`;
  return withProgress(
    label(),
    async (signal, update): Promise<Approval> => {
      const ticker = setInterval(() => update(label()), 1000);
      try {
        while (Date.now() < start.expiresAt) {
          await delay(
            Math.min(start.pollIntervalSec * 1000, start.expiresAt - Date.now()),
            undefined,
            { signal },
          );
          if (Date.now() >= start.expiresAt) break;
          try {
            const poll = await api<PairPollResponse>(config, 'GET', `/pair/${start.pairingId}`, {
              token: start.pollSecret,
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.max(1, Math.min(8000, start.expiresAt - Date.now()))),
              ]),
            });
            if (poll.status === 'approved') return poll;
            if (poll.status === 'expired') return 'expired';
          } catch {
            signal.throwIfAborted();
            // Transient network trouble: keep polling until the code expires.
          }
        }
        return 'expired';
      } finally {
        clearInterval(ticker);
      }
    },
    { interrupted: 'Pairing cancelled.' },
  );
}

/** Offers to set up agents that are here but not alerting yet. */
async function offerSetup(): Promise<number> {
  const pending = HOST_IDS.map((id) => inspectHost(id, true)).filter((report) =>
    report.plugin.status === 'absent'
      ? report.detected && report.hooks.status !== 'ok'
      : !['ready', 'disabled'].includes(report.plugin.status) || report.conflicts.length > 0,
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
  await withProgress(
    'Unpairing this computer from GreatPing',
    async (signal) => {
      try {
        await api(config, 'DELETE', '/machine/me', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
      } catch {
        // The local credential is removed either way; the server copy is revoked
        // when reachable, or can be removed in the app.
      }
      // Cancellation keeps the local credential for a safe retry.
      signal.throwIfAborted();
      saveConfig({ apiUrl: config.apiUrl });
    },
    {
      interrupted:
        'Unpairing interrupted. The local pairing was kept; run greatping status or retry logout.',
    },
  );
  ui.success('Unpaired. This computer no longer sends alerts.');
  return 0;
}
