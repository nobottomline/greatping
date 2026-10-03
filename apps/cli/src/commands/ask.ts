import process from 'node:process';
import type { PingRequest } from '@greatping/protocol';
import { parseDuration } from '../duration';
import { askQuestion, sendNotice } from '../operations';
import { command, elapsed, muted, spinner, ui } from '../ui';
import { UsageError } from './usage';

export async function ask(
  question: string | undefined,
  options: { choices?: string; allowText?: boolean; timeout?: string; json?: boolean },
): Promise<number> {
  if (!question?.trim()) throw new UsageError('ask', 'Write the question to send.');
  const timeout = parseDuration(options.timeout ?? '30m');
  if (timeout === null)
    throw new UsageError('ask', `Invalid timeout "${options.timeout}". Use 30s, 5m or 1h.`);
  const choices = (options.choices ?? '')
    .split(',')
    .map((choice) => choice.trim())
    .filter(Boolean);
  if (options.allowText && choices.length === 0)
    throw new UsageError('ask', 'Use --allow-text together with --choices.');
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
  const started = Date.now();
  let progress: ReturnType<typeof spinner> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const stopProgress = () => {
    clearInterval(ticker);
    progress?.stop();
  };
  try {
    const result = await askQuestion(question, choices, timeout, {
      signal: controller.signal,
      allowText: options.allowText === true,
      onCreated(request) {
        warnIfPaused(request);
        if (options.json) return;
        progress = spinner('Waiting for your answer in GreatPing');
        ticker = setInterval(
          () =>
            progress?.update(
              `Waiting for your answer in GreatPing ${muted(`· ${elapsed(started)}`)}`,
            ),
          1000,
        );
      },
    });
    // Finish transient output before either stream receives the final result.
    stopProgress();
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    if (exitCode) {
      ui.warn('Question withdrawn.');
      return exitCode;
    }
    if (result.status !== 'answered') {
      ui.error(`The question was ${result.status}.`);
      return 2;
    }
    if (!options.json) {
      ui.success(`Answered ${muted(`after ${elapsed(started)}`)}`);
      process.stdout.write(`${result.answer?.choice ?? result.answer?.text ?? ''}\n`);
    }
    return 0;
  } finally {
    stopProgress();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

export async function notify(
  message: string | undefined,
  options: { title?: string; json?: boolean },
): Promise<number> {
  if (!message?.trim()) throw new UsageError('notify', 'Write the message to send.');
  const result = await sendNotice(message, options.title);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'paused') warnIfPaused({ paused: true });
  else ui.success('GreatPing accepted the notice.');
  return 0;
}

function warnIfPaused(request: Pick<PingRequest, 'paused'>): void {
  if (!request.paused) return;
  ui.warn('Alerts from this computer are paused: it is in the app, but no device was alerted.');
  ui.next(muted(`Resume with ${command('greatping resume')}.`));
}
