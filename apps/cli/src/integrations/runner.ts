import process from 'node:process';
import {
  type AlertHost,
  type CreateRequestBody,
  LIMITS,
  type ResolveRequestBody,
  type ResolveRequestResponse,
} from '@greatping/protocol';
import { api } from '../api';
import { type Config, isPaired, loadConfig } from '../config';
import { correlationId, loadSettings, projectFields, readSettings, threadId } from '../identity';
import { reportMachine } from '../report';
import { type ClaudeAlert, claudeSteps, codexSteps, type HookInput, type HookStep } from './events';
import { isAway } from './presence';
import { forget, type HostId, markOpen, openedAgo, pruneAlerts, touchHeartbeat } from './state';

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The alert host each hook host reports as. */
export const ALERT_HOST: Record<HostId, AlertHost> = { claude: 'claude-code', codex: 'codex' };

/**
 * Hooks of one event run in parallel processes: the event that closes a
 * prompt can reach the server before the one that opened it. A mark this
 * young may still be on its way, so closing it is retried briefly.
 */
const RACE_WINDOW_MS = 10_000;

async function resolveOnServer(
  config: Config,
  body: ResolveRequestBody,
  openedAgoMs: number,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const result = await api<ResolveRequestResponse>(config, 'POST', '/requests/resolve', {
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (result.resolved > 0 || openedAgoMs + attempt * 1500 > RACE_WINDOW_MS || attempt === 3) {
      return;
    }
    await pause(1500);
  }
}

export async function runSteps(
  host: HostId,
  session: string,
  steps: HookStep[],
  config: Config,
  cwd?: string,
): Promise<void> {
  const paired = isPaired(config);
  const alertHost = ALERT_HOST[host];
  // Without settings there is no secret yet, so nothing can have been opened here.
  const settings = paired ? loadSettings() : readSettings();
  if (!settings) return;
  const thread = threadId(alertHost, session, settings.secret);
  for (const step of steps) {
    if (step.op === 'notify') {
      if (!paired) continue;
      const correlation = correlationId(alertHost, session, step.correlation, settings.secret);
      markOpen(host, thread, correlation);
      const { projectKey, projectLabel } = projectFields(cwd, settings);
      const body: CreateRequestBody = {
        kind: 'attention',
        host: alertHost,
        reason: step.reason,
        thread,
        correlation,
        ...(projectKey ? { projectKey } : {}),
        content: { enc: 0, ...(projectLabel ? { projectLabel } : {}) },
        timeoutSec: LIMITS.attentionTimeoutSec,
        away: isAway(),
      };
      await api(config, 'POST', '/requests', { body, signal: AbortSignal.timeout(3000) });
      continue;
    }
    const correlation =
      step.op === 'resolve'
        ? correlationId(alertHost, session, step.correlation, settings.secret)
        : undefined;
    const age = openedAgo(host, thread, correlation);
    // Nothing of this prompt or thread was opened here: no request at all.
    if (age === null) continue;
    if (paired) {
      await resolveOnServer(
        config,
        { host: alertHost, thread, ...(correlation ? { correlation } : {}) },
        age,
      );
    }
    forget(host, thread, correlation);
  }
}

/**
 * Entry point a host runs for each hook event. It stays silent and never
 * fails: an alert problem must not affect the host or its prompt.
 */
export async function runHook(
  host: HostId,
  options: { finished: boolean; alerts?: ClaudeAlert[] },
): Promise<number> {
  try {
    const input = await readHookInput();
    if (!input || input.hook_event_name === PROBE_EVENT) return 0;
    const previousRun = touchHeartbeat(host);
    // A session or shell can opt out: GREATPING_DISABLE=1 claude …
    if (process.env.GREATPING_DISABLE && process.env.GREATPING_DISABLE !== '0') return 0;
    const steps =
      host === 'claude'
        ? claudeSteps(input, {
            finished: options.finished,
            ...(options.alerts ? { alerts: options.alerts } : {}),
          })
        : codexSteps(input, { finished: options.finished });
    const config = loadConfig();
    if (steps.length > 0 && input.session_id) {
      await runSteps(host, input.session_id, steps, config, input.cwd);
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
