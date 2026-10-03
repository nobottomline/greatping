import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import process from 'node:process';
import { sendNotice } from '../operations';
import { muted, ui } from '../ui';
import { UsageError } from './usage';

/**
 * What the alert calls a command: the program and, when it is a plain word,
 * its subcommand ("pnpm test", "make deploy"). Arguments never leave the
 * computer: they can hold tokens, paths or private names.
 */
export function commandLabel(argv: string[]): string {
  const [program, next] = argv;
  const name = basename(program ?? 'command');
  return next && /^[A-Za-z][\w:.-]{0,30}$/.test(next) ? `${name} ${next}` : name;
}

/** "45s", "4m 12s", "1h 3m". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Runs a command with this terminal and sends one alert when it ends: whether
 * it succeeded, its exit code and how long it took. Exits with the command's
 * code, so it fits in scripts. An interrupted command (Ctrl+C) alerts
 * nobody: the user is at the keyboard.
 */
export async function run(
  argv: string[],
  options: { onFail?: boolean; title?: string },
): Promise<number> {
  if (argv.length === 0)
    throw new UsageError('run', 'Give the command to run: greatping run -- pnpm test');
  const label = options.title?.trim() || commandLabel(argv);
  const started = Date.now();
  const outcome = await new Promise<{ code: number; signal?: NodeJS.Signals; error?: Error }>(
    (resolve) => {
      const child = spawn(argv[0] as string, argv.slice(1), { stdio: 'inherit' });
      // The terminal sends Ctrl+C to the whole process group; the child gets it too.
      const ignore = () => {};
      process.on('SIGINT', ignore);
      process.on('SIGTERM', ignore);
      const done = (result: { code: number; signal?: NodeJS.Signals; error?: Error }) => {
        process.off('SIGINT', ignore);
        process.off('SIGTERM', ignore);
        resolve(result);
      };
      child.on('error', (error) => done({ code: 127, error }));
      child.on('exit', (code, signal) =>
        done(signal ? { code: 128 + (signalNumber(signal) ?? 0), signal } : { code: code ?? 1 }),
      );
    },
  );
  const elapsed = durationText(Date.now() - started);
  if (outcome.error) ui.error(`Could not start ${label}.`, outcome.error.message);
  if (outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM') return outcome.code;
  const failed = outcome.code !== 0;
  if (!failed && options.onFail) return outcome.code;
  const message = outcome.error
    ? `Could not start: ${outcome.error.message}`
    : failed
      ? `Exit code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''} after ${elapsed}.`
      : `Finished in ${elapsed}.`;
  try {
    const sent = await sendNotice(message, `${label} ${failed ? 'failed' : 'succeeded'}`);
    if (sent.status === 'paused')
      ui.warn(`${label} ended; alerts from this computer are paused, so nobody was alerted.`);
  } catch (error) {
    // The command's result matters more than the alert: report and keep its code.
    ui.warn(
      `${label} ended, but GreatPing could not send the alert: ${error instanceof Error ? error.message : String(error)}`,
    );
    ui.next(muted('Check the pairing with greatping status.'));
  }
  return outcome.code;
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[
    signal
  ];
}
