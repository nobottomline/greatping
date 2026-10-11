import type { Key } from 'node:readline';
import { type CommonOptions, isCancel, multiselect, select } from '@clack/prompts';
import { colorEnabled } from './ui';

export interface PickerItem {
  id: string;
  label: string;
  hint: string;
  selected: boolean;
}

/** Clack owns rendering and raw mode; GreatPing owns streams and exit codes. */
async function prompt<T>(work: (options: CommonOptions) => Promise<T | symbol>): Promise<T | null> {
  const input = process.stdin;
  const output = process.stderr;
  const controller = new AbortController();
  const wasFlowing = input.readableFlowing === true;
  const wasRaw = input.isRaw;
  // Clack uses Node's styleText, whose default stream is stdout. Honor our
  // stderr color policy even when stdout is piped or --no-color is explicit.
  const previousForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = colorEnabled ? '1' : '0';
  const keypress = (_text: string, key: Key) => {
    if (key.ctrl && key.name === 'c') process.exitCode = 130;
  };
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  input.on('keypress', keypress);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await work({ input, output, signal: controller.signal });
    return isCancel(result) ? null : (result as T);
  } finally {
    input.off('keypress', keypress);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousForceColor;
    if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}

// Reserve room for the prompt, keyboard instructions and a wrapped hint.
const maxItems = () => Math.max(2, Math.min(8, (process.stderr.rows ?? 24) - 7));

/** Every review row is selectable, so a short terminal never hides a decision. */
export function menu(
  message: string,
  actions: Array<{ value: string; label: string; hint: string }>,
): Promise<string | null> {
  return prompt<string>((io) =>
    select<string>({ ...io, message, options: actions, maxItems: maxItems() }),
  );
}

/** Space toggles; Enter keeps choices; Escape discards this screen's edits. */
export function pickSetup(items: PickerItem[], message: string): Promise<Set<string> | null> {
  if (!items.length) return Promise.resolve(new Set());
  return prompt<string[]>((io) =>
    multiselect({
      ...io,
      message,
      options: items.map((item) => ({ value: item.id, label: item.label, hint: item.hint })),
      initialValues: items.filter((item) => item.selected).map((item) => item.id),
      required: false,
      maxItems: maxItems(),
    }),
  ).then((result) => (result === null ? null : new Set(result)));
}
