import process from 'node:process';
import { createInterface } from 'node:readline';
import { createColors } from 'picocolors';

/**
 * Terminal presentation. Everything meant for a person goes to stderr, so
 * stdout carries only command results (an answer, JSON) and stays safe to pipe.
 *
 * Color follows the usual conventions: NO_COLOR disables it, FORCE_COLOR
 * enables it, otherwise it is on only for an interactive stderr. Spinners and
 * prompts appear only when both stdin and stderr are terminals.
 */

const env = process.env;
const out = process.stderr;

function colorSupported(): boolean {
  if ('NO_COLOR' in env || process.argv.includes('--no-color')) return false;
  if ('FORCE_COLOR' in env) return env.FORCE_COLOR !== '0';
  return Boolean(out.isTTY) && env.TERM !== 'dumb';
}

export const colorEnabled = colorSupported();
export const color = createColors(colorEnabled);
export const interactive = Boolean(out.isTTY && process.stdin.isTTY) && !env.CI;

const unicode = process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM);
const glyph = {
  ok: unicode ? '✔' : '√',
  fail: unicode ? '✖' : '×',
  warn: unicode ? '▲' : '!',
  info: unicode ? '●' : '*',
  arrow: unicode ? '→' : '>',
  dot: unicode ? '·' : '-',
};

export function print(line = ''): void {
  out.write(`${line}\n`);
}

/** A command or flag the user can type, e.g. `greatping login`. */
export const command = (text: string) => color.cyan(text);
/** Secondary information. */
export const muted = (text: string) => color.dim(text);
export const strong = (text: string) => color.bold(text);

export const ui = {
  /** Screen title for interactive flows: "GreatPing · Pair this computer". */
  heading(title: string) {
    print();
    print(`  ${color.bold('GreatPing')} ${muted(glyph.dot)} ${title}`);
    print();
  },
  success(message: string) {
    print(`  ${color.green(glyph.ok)} ${message}`);
  },
  info(message: string) {
    print(`  ${color.blue(glyph.info)} ${message}`);
  },
  warn(message: string) {
    print(`  ${color.yellow(glyph.warn)} ${message}`);
  },
  error(message: string, hint?: string) {
    print(`  ${color.red(glyph.fail)} ${message}`);
    if (hint) print(`    ${muted(hint)}`);
  },
  /** Follow-up suggestion: "→ Run greatping login". */
  next(message: string) {
    print(`  ${muted(glyph.arrow)} ${message}`);
  },
  /** Aligned label/value rows. */
  rows(rows: Array<[label: string, value: string]>) {
    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) print(`  ${muted(label.padEnd(width))}  ${value}`);
  },
  blank() {
    print();
  },
};

const frames = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];

export interface Spinner {
  update(text: string): void;
  /** Clears the spinner line; prints nothing. */
  stop(): void;
}

/**
 * Single-line activity indicator. Non-interactive runs get no output at all,
 * so logs and MCP callers only see results and errors.
 */
export function spinner(text: string): Spinner {
  if (!interactive) return { update() {}, stop() {} };
  let label = text;
  let frame = 0;
  const render = () => {
    out.write(`\r\x1b[2K  ${color.cyan(frames[frame % frames.length] ?? '')} ${label}`);
    frame++;
  };
  out.write('\x1b[?25l');
  render();
  const timer = setInterval(render, 80);
  const restore = () => out.write('\x1b[?25h');
  process.once('exit', restore);
  let stopped = false;
  return {
    update(next) {
      label = next;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      out.write('\r\x1b[2K');
      restore();
      process.off('exit', restore);
    },
  };
}

/** Yes/no question. Returns `fallback` without asking when not interactive. */
export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!interactive) return fallback;
  const rl = createInterface({ input: process.stdin, output: out });
  const suffix = muted(fallback ? '(Y/n)' : '(y/N)');
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  ${color.cyan('?')} ${question} ${suffix} `, resolve);
      rl.once('SIGINT', () => {
        print();
        resolve('');
        process.exitCode = 130;
      });
    });
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return process.exitCode === 130 ? false : fallback;
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

/** "9:41" style countdown. */
export function countdown(untilMs: number): string {
  const seconds = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Elapsed time: "12s", "3m 05s". */
export function elapsed(sinceMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
