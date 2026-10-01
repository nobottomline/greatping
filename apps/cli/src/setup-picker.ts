import process from 'node:process';
import { emitKeypressEvents, type Key } from 'node:readline';
import { color, muted } from './ui';

export interface PickerItem {
  id: string;
  group: string;
  label: string;
  hint: string;
  selected: boolean;
}

/** A single settings screen. Enter toggles a row; the final row commits it. */
export async function pickSetup(
  items: PickerItem[],
  mode: 'toggle' | 'select' = 'toggle',
): Promise<Set<string> | null> {
  if (!items.length) return new Set();
  const input = process.stdin;
  const output = process.stderr;
  const selected = new Set(items.filter((item) => item.selected).map((item) => item.id));
  let cursor = 0;
  const last = mode === 'toggle' ? items.length : items.length - 1;
  let drawn = 0;
  const previousRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);

  function fit(value: string): string {
    const width = Math.max(12, (output.columns ?? 80) - 7);
    return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
  }
  function erase(): void {
    if (!drawn) return;
    output.write(`\x1b[${drawn}A\r\x1b[0J`);
    drawn = 0;
  }
  function row(item: PickerItem, index: number, compact = false): string {
    const active = cursor === index;
    const enabled = mode === 'select' ? active : selected.has(item.id);
    const mark = enabled ? color.green('●') : muted('○');
    const label = fit(compact ? `${item.group}: ${item.label}` : item.label);
    const arrow = active ? color.cyan('›') : ' ';
    return `  ${arrow} ${mark} ${active ? color.cyan(label) : enabled ? label : muted(label)}`;
  }
  function draw(): void {
    erase();
    const rows: string[] = [];
    let group = '';
    for (const [i, item] of items.entries()) {
      if (group !== item.group) {
        if (rows.length) rows.push('');
        rows.push(`  ${color.bold(item.group)}`);
        group = item.group;
      }
      rows.push(row(item, i));
    }
    rows.push('');
    const count = items.filter((item) => selected.has(item.id)).length;
    const action = fit(`› Continue${count ? '' : ' — disable alerts and tools'}`);
    if (mode === 'toggle')
      rows.push(
        `  ${cursor === items.length ? color.bold(color.cyan(action)) : muted('  Continue')}`,
      );
    const hint =
      cursor === items.length
        ? 'Save these settings. Existing selections can be turned off.'
        : (items[cursor]?.hint ?? '');
    rows.push(
      '',
      `  ${muted(fit(hint))}`,
      `  ${muted(fit(mode === 'toggle' ? '↑ ↓ Move   Enter Toggle / continue   Esc Cancel   ● On ○ Off' : '↑ ↓ Move   Enter Select   Esc Skip'))}`,
    );

    // Keep the focused option visible in short terminals. Group and labels
    // remain explicit in the compact view; redraw never wraps a line.
    const available = Math.max(7, (output.rows ?? 24) - 7);
    const visible =
      rows.length <= available
        ? rows
        : [
            `  ${color.bold(items[cursor]?.group ?? 'Save settings')}`,
            `  ${muted(`${cursor + 1} / ${last + 1}`)}`,
            ...items
              .slice(Math.max(0, cursor - 1), Math.min(items.length, cursor + 2))
              .map((item, i) => {
                const index = Math.max(0, cursor - 1) + i;
                return row(item, index, true);
              }),
            ...(mode === 'toggle'
              ? [
                  '',
                  `  ${cursor === items.length ? color.bold(color.cyan(action)) : muted('  Continue')}`,
                ]
              : []),
            `  ${muted(fit(mode === 'toggle' ? '↑↓ Move  Enter Toggle  Esc Cancel' : '↑↓ Move  Enter Select  Esc Skip'))}`,
          ].slice(0, available);
    output.write(`${visible.join('\n')}\n`);
    drawn = visible.length;
  }

  return new Promise((resolve) => {
    let done = false;
    function finish(result: Set<string> | null): void {
      if (done) return;
      done = true;
      erase();
      input.off('keypress', keypress);
      input.off('end', cancel);
      output.off('resize', draw);
      process.off('SIGINT', cancel);
      process.off('SIGTERM', terminate);
      process.off('exit', restore);
      restore();
      if (!wasFlowing) input.pause();
      resolve(result);
    }
    function restore(): void {
      input.setRawMode(previousRaw);
      output.write('\x1b[?25h');
    }
    function cancel(): void {
      process.exitCode = 130;
      finish(null);
    }
    function terminate(): void {
      process.exitCode = 143;
      finish(null);
    }
    function keypress(_text: string, key: Key): void {
      if (key.name === 'escape') {
        finish(null);
        return;
      }
      if (key.ctrl && key.name === 'c') {
        cancel();
        return;
      }
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + last) % (last + 1);
      else if (key.name === 'down' || key.name === 'tab' || key.name === 'j')
        cursor = (cursor + 1) % (last + 1);
      else if (key.name === 'end') cursor = last;
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'return' || key.name === 'space') {
        const item = items[cursor];
        if (mode === 'select') {
          if (!item) return;
          finish(new Set([item.id]));
          return;
        }
        if (cursor === items.length) {
          finish(selected);
          return;
        }
        if (!item) return;
        const id = item.id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      } else return;
      draw();
    }
    input.setRawMode(true);
    input.resume();
    output.write('\x1b[?25l');
    input.on('keypress', keypress);
    input.on('end', cancel);
    output.on('resize', draw);
    process.on('SIGINT', cancel);
    process.on('SIGTERM', terminate);
    process.on('exit', restore);
    draw();
  });
}
