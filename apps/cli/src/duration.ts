/** "90", "90s", "5m", "1h", "2d" → seconds; null when unparseable. */
export function parseDuration(raw: string): number | null {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = { d: 86_400, h: 3600, m: 60, s: 1, '': 1 }[unit] ?? 1;
  return value * scale;
}

/** "3m ago", "2h ago", "5d ago" for past moments; "just now" under a minute. */
export function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Local time of a future moment: "15:30", or "Sat 15:30" beyond today. */
export function clock(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
