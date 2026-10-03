import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AlertHost,
  type Answer,
  type CreateRequestBody,
  type HostIntegration,
  LIMITS,
  type MachineMeResponse,
  type PauseMachineResponse,
  type PingRequest,
} from '@greatping/protocol';
import WebSocket from 'ws';
import { ApiError, api } from './api';
import { UsageError } from './commands/usage';
import { type Config, isPaired, loadConfig } from './config';
import { projectFields } from './identity';
import { hostIntegrations } from './integrations';

function paired(): Config {
  const config = loadConfig();
  if (!isPaired(config))
    throw new UsageError(null, 'This computer is not paired.', 'Run greatping login first.');
  return config;
}

function bounded(signal?: AbortSignal, ms = 8000): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  return AbortSignal.any([signal, deadline]);
}

/** Who sends an explicit question or message, and from which directory. */
export interface Origin {
  /** The MCP client's host, or `cli` for the command itself. */
  host: AlertHost;
  /** Its working directory; only a project label allowed by the user is sent. */
  cwd?: string;
}

const COMMAND_ORIGIN: Origin = { host: 'cli' };

/** Maps an MCP client's self-reported name to an alert host. */
export function hostFromClientName(name: string | undefined): AlertHost {
  const value = (name ?? '').toLowerCase();
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('codex')) return 'codex';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('opencode')) return 'opencode';
  if (value.includes('gemini')) return 'gemini-cli';
  if (/^pi(\b|[-_])/.test(value)) return 'pi';
  return 'other';
}

function originFields(origin: Origin): Pick<CreateRequestBody, 'host' | 'projectKey'> & {
  projectLabel?: string;
} {
  const { projectKey, projectLabel } = projectFields(origin.cwd ?? process.cwd());
  return {
    host: origin.host,
    ...(projectKey ? { projectKey } : {}),
    ...(projectLabel ? { projectLabel } : {}),
  };
}

export interface NoticeResult {
  requestId: string;
  status: 'accepted' | 'paused';
}

export async function sendNotice(
  message: string,
  title?: string,
  signal?: AbortSignal,
  origin: Origin = COMMAND_ORIGIN,
): Promise<NoticeResult> {
  if (!message.trim() || message.length > LIMITS.bodyMaxLength)
    throw new UsageError(
      'notify',
      `Write a message of at most ${LIMITS.bodyMaxLength} characters.`,
    );
  if (title !== undefined && title.length > 100)
    throw new UsageError('notify', 'Titles are limited to 100 characters.');
  const { projectLabel, ...source } = originFields(origin);
  const body: CreateRequestBody = {
    kind: 'notify',
    ...source,
    content: {
      enc: 0,
      body: message.trim(),
      ...(title?.trim() ? { title: title.trim() } : {}),
      ...(projectLabel ? { projectLabel } : {}),
    },
    timeoutSec: 300,
  };
  const request = await api<PingRequest>(paired(), 'POST', '/requests', {
    body,
    signal: bounded(signal),
  });
  return { requestId: request.id, status: request.paused ? 'paused' : 'accepted' };
}

export async function changePause(
  durationSeconds: number | null,
  signal?: AbortSignal,
): Promise<PauseMachineResponse> {
  if (
    durationSeconds !== null &&
    (!Number.isInteger(durationSeconds) ||
      durationSeconds < 60 ||
      durationSeconds > LIMITS.pauseMaxSec)
  )
    throw new UsageError('pause', 'Pause for at least a minute and at most 7 days.');
  return api<PauseMachineResponse>(paired(), 'PUT', '/machine/me/pause', {
    body: { until: durationSeconds === null ? null : Date.now() + durationSeconds * 1000 },
    signal: bounded(signal),
  });
}

export function readMachine(config: Config, signal?: AbortSignal): Promise<MachineMeResponse> {
  return api<MachineMeResponse>(config, 'GET', '/machine/me', { signal: bounded(signal) });
}

export interface AgentStatus {
  paired: boolean;
  connection: 'unpaired' | 'connected' | 'revoked' | 'unreachable';
  alertsPausedUntil: number | null;
  deviceCount: number | null;
  integrations: HostIntegration[];
}

/** Read only: no machine report, settings writes, credentials or device names. */
export async function getAgentStatus(signal?: AbortSignal): Promise<AgentStatus> {
  const config = loadConfig();
  const local = { alertsPausedUntil: null, deviceCount: null, integrations: hostIntegrations() };
  if (!isPaired(config)) return { ...local, paired: false, connection: 'unpaired' };
  try {
    const me = await readMachine(config, signal);
    return {
      ...local,
      paired: true,
      connection: 'connected',
      alertsPausedUntil: me.machine.alertsPausedUntil,
      deviceCount: me.devices.length,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const revoked = error instanceof ApiError && error.status === 401;
    return { ...local, paired: !revoked, connection: revoked ? 'revoked' : 'unreachable' };
  }
}

export interface QuestionResult {
  requestId: string;
  status: 'answered' | 'expired' | 'cancelled' | 'resolved';
  paused: boolean;
  answer?: Answer;
}

export async function askQuestion(
  question: string,
  choices: string[],
  timeoutSeconds: number,
  options: {
    signal?: AbortSignal;
    onCreated?: (request: PingRequest) => void;
    origin?: Origin;
    /** With choices, also accept the user's own words (a question without choices always does). */
    allowText?: boolean;
  } = {},
): Promise<QuestionResult> {
  if (!question.trim() || question.length > LIMITS.bodyMaxLength)
    throw new UsageError('ask', `Write a question of at most ${LIMITS.bodyMaxLength} characters.`);
  if (
    choices.length > LIMITS.choicesMax ||
    choices.some((choice) => !choice.trim() || choice.length > LIMITS.choiceMaxLength)
  )
    throw new UsageError('ask', 'Invalid question choices.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86400)
    throw new UsageError('ask', 'The timeout must be between 10 seconds and 24 hours.');
  const config = paired(),
    { signal } = options;
  signal?.throwIfAborted();
  // Once creation begins, finish it even on cancellation so the returned ID can
  // be withdrawn. Aborting a POST can otherwise orphan a question on the phone.
  const { projectLabel, ...source } = originFields(options.origin ?? COMMAND_ORIGIN);
  const body: CreateRequestBody = {
    kind: 'ask',
    ...source,
    content: {
      enc: 0,
      body: question.trim(),
      choices: choices.map((choice) => choice.trim()),
      ...(choices.length > 0 && options.allowText ? { allowText: true } : {}),
      ...(projectLabel ? { projectLabel } : {}),
    },
    timeoutSec: timeoutSeconds,
  };
  const request = await api<PingRequest>(config, 'POST', '/requests', {
    body,
    signal: AbortSignal.timeout(8000),
  });
  try {
    options.onCreated?.(request);
    const result = await waitForAnswer(config, request, signal);
    if (result.status === 'pending') throw new Error('The question ended without a final state.');
    if (
      result.status === 'answered' &&
      !(result.answer?.choice?.trim() || result.answer?.text?.trim())
    )
      throw new Error('The device returned an empty answer.');
    return {
      requestId: result.id,
      status: result.status,
      paused: request.paused === true,
      ...(result.answer ? { answer: result.answer } : {}),
    };
  } catch (error) {
    if (!signal?.aborted) throw error;
    // Cancellation is acknowledged only after the server accepts withdrawal.
    await api(config, 'POST', `/requests/${request.id}/cancel`, {
      signal: AbortSignal.timeout(3000),
    });
    return { requestId: request.id, status: 'cancelled', paused: request.paused === true };
  }
}

async function waitForAnswer(
  config: Config,
  request: PingRequest,
  signal?: AbortSignal,
): Promise<PingRequest> {
  let lastError: unknown;
  while (Date.now() < request.expiresAt + 10000) {
    signal?.throwIfAborted();
    // Poll first: answers often arrive before the socket connects.
    try {
      const state = await api<PingRequest>(config, 'GET', `/requests/${request.id}`, {
        signal: bounded(signal),
      });
      if (state.status !== 'pending') return state;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      lastError = error;
    }
    signal?.throwIfAborted();
    try {
      const state = await watchRequest(config, request.id, request.expiresAt, signal);
      if (state.status !== 'pending') return state;
    } catch (error) {
      lastError = error;
    }
    await delay(1000, undefined, { signal });
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The question ended without a final state.');
}

function watchRequest(
  config: Config,
  id: string,
  expiresAt: number,
  signal?: AbortSignal,
): Promise<PingRequest> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${config.apiUrl.replace(/^http/, 'ws')}/v1/requests/${id}/ws`, {
      headers: { authorization: `Bearer ${config.machineToken}` },
    });
    let settled = false;
    const finish = (request?: PingRequest, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.terminate();
      if (request) resolve(request);
      else reject(error ?? new Error('Connection closed.'));
    };
    const abort = () => finish(undefined, new Error('Request cancelled.'));
    const timer = setTimeout(
      () => finish(undefined, new Error('WebSocket idle.')),
      Math.min(30000, Math.max(1000, expiresAt - Date.now() + 5000)),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as { request?: PingRequest };
        if (event.request?.status && event.request.status !== 'pending') finish(event.request);
      } catch {
        finish(undefined, new Error('Invalid WebSocket event.'));
      }
    });
    socket.on('error', (error) => finish(undefined, error));
    socket.on('close', () => finish());
  });
}
