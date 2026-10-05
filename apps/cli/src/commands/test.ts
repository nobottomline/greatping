import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type { PushTestDevice, PushTestResponse } from '@greatping/protocol';
import { api } from '../api';
import { isPaired, loadConfig } from '../config';
import { withProgress } from '../progress';
import { color, muted, print, ui } from '../ui';
import { UsageError } from './usage';

/** How long to wait for Apple's and Google's answers before reporting what is known. */
const WAIT_MS = 30_000;
const POLL_MS = 2_000;

const MODE = { first: 'First', standard: 'Standard', backup: 'Backup', off: 'Off' } as const;

function provider(device: PushTestDevice): string {
  return device.platform === 'ios' ? 'Apple' : 'Google';
}

/** One line per device: what happened, and what to do about it. */
export function describeDevice(device: PushTestDevice): { line: string; hint?: string } {
  const name = device.mode ? `${device.name} ${muted(`(${MODE[device.mode]})`)}` : device.name;
  switch (device.status) {
    case 'accepted':
      return { line: `${color.green('✔')} ${name} — accepted by ${provider(device)}` };
    case 'sending':
      return {
        line: `${color.yellow('…')} ${name} — sent, no answer from ${provider(device)} yet`,
        hint: 'Run greatping test again in a minute to see the answer.',
      };
    case 'skipped':
      return device.reason === 'off'
        ? {
            line: `${muted('•')} ${name} — not sent: set to Off for this computer`,
            hint: 'Change it on the computer’s screen in the app if it should get alerts.',
          }
        : {
            line: `${muted('•')} ${name} — not sent: notifications are not set up on it`,
            hint: 'Open GreatPing on that device and allow notifications.',
          };
    default: {
      const detail = device.detail ? muted(` (${device.detail})`) : '';
      const hint =
        device.reason === 'device_not_registered'
          ? 'GreatPing was removed or reinstalled there; open it again to register.'
          : device.reason === 'credentials'
            ? `${provider(device)} refused GreatPing’s push credentials: a service problem, not your device. Report it to support@greatping.com.`
            : device.reason === 'rate_limited'
              ? 'Too many notifications reached the device; try again shortly.'
              : 'Try again shortly; if it persists, report it to support@greatping.com.';
      return { line: `${color.red('✖')} ${name} — refused${detail}`, hint };
    }
  }
}

/**
 * Sends a test notification to every device of the account the way this
 * computer's alerts reach them, and reports per device what Apple or Google
 * said. "Accepted" is as far as a server can know: check the device itself.
 */
export async function test(options: { json?: boolean }): Promise<number> {
  const config = loadConfig();
  if (!isPaired(config))
    throw new UsageError(null, 'This computer is not paired.', 'Run greatping login first.');
  const result = await withProgress(
    'Sending a test notification',
    async (signal, update) => {
      let result = await api<PushTestResponse>(config, 'POST', '/machine/me/test', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const deadline = Date.now() + WAIT_MS;
      while (result.pending && Date.now() < deadline) {
        update(`Waiting for Apple and Google ${muted('· up to 30 s')}`);
        await delay(POLL_MS, undefined, { signal });
        result = await api<PushTestResponse>(config, 'GET', `/push-tests/${result.id}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
      }
      return result;
    },
    {
      json: Boolean(options.json),
      interrupted: 'Test interrupted. A notification may already have been sent; check the app.',
    },
  );
  const reached = result.devices.some((device) => device.status === 'accepted');
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return reached ? 0 : 1;
  }
  ui.heading('Test notification');
  if (result.devices.length === 0) ui.warn('No device is in this account yet.');
  for (const device of result.devices) {
    const { line, hint } = describeDevice(device);
    print(`  ${line}`);
    if (hint && device.status !== 'accepted') print(`    ${muted(hint)}`);
  }
  ui.blank();
  if (reached)
    ui.next(
      'Check that it appeared on each device: “accepted” means Apple or Google took it, not that it was shown.',
    );
  else ui.error('No device could be reached.');
  return reached ? 0 : 1;
}
