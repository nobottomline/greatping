import process from 'node:process';
import { LIMITS, type PingRequest } from '@greatping/protocol';
import WebSocket from 'ws';
import { api } from '../api';
import { type Config, isPaired, loadConfig } from '../config';
import { parseDuration } from '../duration';
import { command, elapsed, muted, spinner, ui } from '../ui';
import { UsageError } from './usage';

export async function ask(
  question: string | undefined,
  options: { server?: string; choices?: string; timeout?: string; json?: boolean },
): Promise<number> {
  if (!question?.trim()) throw new UsageError('ask', 'Write the question to send.');
  if (question.length > LIMITS.bodyMaxLength)
    throw new UsageError('ask', `Questions are limited to ${LIMITS.bodyMaxLength} characters.`);
  const choices = (options.choices ?? '')
    .split(',')
    .map((choice) => choice.trim())
    .filter(Boolean);
  if (choices.length > LIMITS.choicesMax)
    throw new UsageError('ask', `Use at most ${LIMITS.choicesMax} choices.`);
  if (choices.some((choice) => choice.length > LIMITS.choiceMaxLength))
    throw new UsageError('ask', `Each choice is limited to ${LIMITS.choiceMaxLength} characters.`);
  const timeoutSec = parseDuration(options.timeout ?? '30m');
  if (timeoutSec === null)
    throw new UsageError(
      'ask',
      `Invalid timeout "${options.timeout}". Use a value like 30s, 5m or 1h.`,
    );
  if (timeoutSec < 10 || timeoutSec > 86_400)
    throw new UsageError('ask', 'The timeout must be between 10 seconds and 24 hours.');

  const config = requirePairing(options.server);
  const request = await api<PingRequest>(config, 'POST', '/requests', {
    body: { kind: 'ask', body: question.trim(), choices, timeoutSec },
  });

  warnIfPaused(request);
  const started = Date.now();
  const progress = spinner('Waiting for your answer in GreatPing');
  const ticker = setInterval(
    () => progress.update(`Waiting for your answer in GreatPing ${muted(`· ${elapsed(started)}`)}`),
    1000,
  );
  const cancellation = cancelOnInterrupt(config, request.id, () => {
    clearInterval(ticker);
    progress.stop();
    ui.warn('Question withdrawn.');
  });
  let result: PingRequest;
  try {
    result = await waitForAnswer(config, request);
  } finally {
    clearInterval(ticker);
    progress.stop();
    cancellation.remove();
  }
  // Interrupted: the handler withdraws the question and exits on its own.
  if (cancellation.stopping()) return new Promise<number>(() => {});

  if (result.status !== 'answered' || !result.answer) {
    ui.error(
      result.status === 'expired'
        ? 'The question expired without an answer.'
        : `The question was ${result.status}.`,
    );
    return 2;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ requestId: result.id, answer: result.answer })}\n`);
  } else {
    ui.success(`Answered ${muted(`after ${elapsed(started)}`)}`);
    process.stdout.write(`${result.answer.choice ?? result.answer.text ?? ''}\n`);
  }
  return 0;
}

export async function notify(
  message: string | undefined,
  options: { server?: string; title?: string },
): Promise<number> {
  if (!message?.trim()) throw new UsageError('notify', 'Write the message to send.');
  if (message.length > LIMITS.bodyMaxLength)
    throw new UsageError('notify', `Messages are limited to ${LIMITS.bodyMaxLength} characters.`);
  const config = requirePairing(options.server);
  const request = await api<PingRequest>(config, 'POST', '/requests', {
    body: {
      kind: 'notify',
      body: message.trim(),
      ...(options.title?.trim() ? { title: options.title.trim().slice(0, 100) } : {}),
      timeoutSec: 300,
    },
  });
  if (request.paused) warnIfPaused(request);
  else ui.success('Sent to your devices.');
  return 0;
}

/** Paused computers still list requests, but alert nobody: say so, since nobody may see it. */
function warnIfPaused(request: PingRequest): void {
  if (!request.paused) return;
  ui.warn('Alerts from this computer are paused: it is in the app, but no device was alerted.');
  ui.next(muted(`Resume with ${command('greatping resume')}.`));
}

function requirePairing(server?: string): Config {
  const config = loadConfig(server);
  if (!isPaired(config)) {
    throw new UsageError(
      null,
      'This computer is not paired.',
      `Run ${command('greatping login')} first.`,
    );
  }
  return config;
}

/** Ctrl+C or SIGTERM withdraws the question on your devices before exiting. */
function cancelOnInterrupt(config: Config, requestId: string, onStop: () => void) {
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    onStop();
    const deadline = setTimeout(() => process.exit(code), 3000);
    void api(config, 'POST', `/requests/${requestId}/cancel`)
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline);
        process.exit(code);
      });
  };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  return {
    stopping: () => stopping,
    remove: () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    },
  };
}

/**
 * Waits on the request's WebSocket and falls back to HTTP after disconnects or
 * when the answer arrived before the socket connected.
 */
async function waitForAnswer(config: Config, request: PingRequest): Promise<PingRequest> {
  let lastError: unknown;
  while (Date.now() < request.expiresAt + 10_000) {
    try {
      const state = await watchRequest(config, request.id, request.expiresAt);
      if (state.status !== 'pending') return state;
    } catch (error) {
      lastError = error;
    }
    try {
      const state = await api<PingRequest>(config, 'GET', `/requests/${request.id}`);
      if (state.status !== 'pending') return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The question ended without a final state.');
}

function watchRequest(config: Config, id: string, expiresAt: number): Promise<PingRequest> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${config.apiUrl.replace(/^http/, 'ws')}/v1/requests/${id}/ws`, {
      headers: { authorization: `Bearer ${config.machineToken}` },
    });
    let settled = false;
    const finish = (request?: PingRequest, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (request) resolve(request);
      else reject(error ?? new Error('connection closed'));
    };
    const timer = setTimeout(
      () => finish(undefined, new Error('websocket idle')),
      Math.min(30_000, Math.max(1000, expiresAt - Date.now() + 5000)),
    );
    socket.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as { request?: PingRequest };
        if (event.request?.status && event.request.status !== 'pending') finish(event.request);
      } catch {
        finish(undefined, new Error('invalid websocket event'));
      }
    });
    socket.on('error', (error) => finish(undefined, error));
    socket.on('close', () => finish());
  });
}
