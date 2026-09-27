import process from 'node:process';
import { LIMITS } from '@greatping/protocol';
import { api } from '../api';
import { type Config, isPaired, loadConfig } from '../config';
import { reportMachine } from '../report';
import { claudeSteps, codexSteps, type HookInput, type HookStep } from './events';
import { isAway } from './presence';
import {
  findAlert,
  forgetAlert,
  type HostId,
  type OpenAlert,
  openAlert,
  pruneAlerts,
  sessionAlerts,
  touchHeartbeat,
} from './state';

/** The event `greatping doctor` sends to check that an installed hook runs. */
export const PROBE_EVENT = 'GreatPingProbe';

/** Refresh what devices show about this computer at most this often from hooks. */
const REPORT_INTERVAL_MS = 3600_000;

export async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) return null;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HookInput) : null;
  } catch {
    return null;
  }
}

/** `claude -p` and SDK runs are scripted; nobody is waiting at a terminal. */
function claudeInteractive(): boolean {
  return !(process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveAlert(config: Config, alert: OpenAlert): Promise<void> {
  // The event that opened the alert runs in parallel and may not have reached
  // the server yet; an unknown key is retried briefly before it is dropped.
  for (let attempt = 1; ; attempt++) {
    const result = await api<{ resolved: boolean }>(config, 'POST', '/requests/resolve', {
      body: { sourceKey: alert.sourceKey },
      signal: AbortSignal.timeout(3000),
    });
    if (result.resolved || attempt === 3) break;
    await pause(1500);
  }
  forgetAlert(alert);
}

export async function runSteps(
  host: HostId,
  session: string,
  steps: HookStep[],
  config: Config,
): Promise<void> {
  const paired = isPaired(config);
  for (const step of steps) {
    if (step.op === 'notify') {
      if (!paired) continue;
      const alert = openAlert(host, session, step.correlation);
      await api(config, 'POST', '/requests', {
        body: {
          kind: 'notify',
          title: step.title,
          body: step.body,
          sourceKey: alert.sourceKey,
          timeoutSec: LIMITS.attentionTimeoutSec,
          away: isAway(),
        },
        signal: AbortSignal.timeout(3000),
      });
      continue;
    }
    const alerts =
      step.op === 'resolve'
        ? [findAlert(host, session, step.correlation)].filter((a): a is OpenAlert => a !== null)
        : sessionAlerts(host, session);
    if (!paired) {
      alerts.forEach(forgetAlert);
      continue;
    }
    await Promise.allSettled(alerts.map((alert) => resolveAlert(config, alert)));
  }
}

/**
 * Entry point a host runs for each hook event. It stays silent and never
 * fails: an alert problem must not affect the host or its prompt.
 */
export async function runHook(host: HostId, options: { finished: boolean }): Promise<number> {
  try {
    const input = await readHookInput();
    if (!input || input.hook_event_name === PROBE_EVENT) return 0;
    const previousRun = touchHeartbeat(host);
    // A session or shell can opt out: GREATPING_DISABLE=1 claude …
    if (process.env.GREATPING_DISABLE && process.env.GREATPING_DISABLE !== '0') return 0;
    const steps =
      host === 'claude'
        ? claudeSteps(input, { finished: options.finished, interactive: claudeInteractive() })
        : codexSteps(input, { finished: options.finished, interactive: true });
    const config = loadConfig();
    if (steps.length > 0 && input.session_id) {
      await runSteps(host, input.session_id, steps, config);
    }
    if (steps.some((step) => step.op === 'resolve-session')) pruneAlerts();
    if (previousRun === null || Date.now() - previousRun > REPORT_INTERVAL_MS) {
      await reportMachine(config);
    }
  } catch {
    // Deliberately silent.
  }
  return 0;
}
