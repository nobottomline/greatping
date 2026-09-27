import { toQR } from 'toqr';

const QUIET_ZONE = 2;

/**
 * Renders a QR code for the terminal.
 *
 * With color, each module is two background-colored spaces, dark on white.
 * Background color fills the whole character cell, including the line
 * spacing that leaves gaps between half-block glyphs, so the code scans on any
 * theme or font. Without color, half blocks keep it compact; dark modules are
 * drawn as blocks, which suits light-on-dark terminals.
 */
export function renderQr(payload: string, useColor: boolean): string[] {
  const matrix = toQR(payload);
  const size = Math.sqrt(matrix.length);
  const width = size + QUIET_ZONE * 2;
  const dark = (x: number, y: number) => {
    const mx = x - QUIET_ZONE;
    const my = y - QUIET_ZONE;
    return mx >= 0 && my >= 0 && mx < size && my < size && matrix[my * size + mx] === 1;
  };

  const lines: string[] = [];
  if (useColor) {
    for (let y = 0; y < width; y++) {
      let line = '';
      let current: boolean | null = null;
      for (let x = 0; x < width; x++) {
        const isDark = dark(x, y);
        if (isDark !== current) {
          line += isDark ? '\x1b[40m' : '\x1b[107m';
          current = isDark;
        }
        line += '  ';
      }
      lines.push(`${line}\x1b[0m`);
    }
    return lines;
  }
  for (let y = 0; y < width; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < width && dark(x, y + 1);
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}
