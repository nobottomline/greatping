import type {
  DiagnosticsComputer,
  DiagnosticsDevice,
  DiagnosticsPushTest,
  DiagnosticsReport,
  DiagnosticsRequest,
  DiagnosticsTimings,
} from './index';

/**
 * The support report as plain text (docs/support-id.md, option B). The app
 * and the CLI show exactly this before the user sends it, so what support
 * receives is what the user read. Times are UTC, so they read the same for
 * the user and for support.
 */
export function formatDiagnostics(report: DiagnosticsReport, local: string[] = []): string {
  const lines: string[] = [
    'GreatPing support report',
    `Generated ${time(report.generatedAt)} · ${report.scope === 'account' ? 'from a device' : 'from a computer'} · format ${report.schemaVersion}`,
  ];
  if (local.length > 0) lines.push('', 'This app or CLI', ...local.map((line) => `  ${line}`));
  const plan = report.plan;
  lines.push(
    '',
    `Plan: ${plan.tier}${plan.computerLimit === null ? '' : ` · up to ${plan.computerLimit} computer${plan.computerLimit === 1 ? '' : 's'}`} · custom timings ${yes(plan.customTimings)} · history ${plan.historyDays} days`,
  );
  if (report.devices.length > 0) {
    lines.push('', 'Devices');
    for (const device of report.devices) lines.push(...deviceLines(device));
  }
  lines.push('', 'Computers');
  if (report.computers.length === 0) lines.push('  none');
  for (const computer of report.computers) lines.push(...computerLines(computer));
  lines.push('', `Latest alerts (${report.requests.length})`);
  if (report.requests.length === 0) lines.push('  none');
  for (const request of report.requests) lines.push(requestLine(request));
  if (report.pushTests.length > 0) {
    // Stored when each test ran; a later receipt does not change them.
    lines.push('', 'Test notifications, last day (as recorded when sent)');
    for (const test of report.pushTests) lines.push(testLine(test));
  }
  if (report.truncated) lines.push('', 'Some devices, computers or alerts were left out.');
  return `${lines.join('\n')}\n`;
}

function time(at: number | null): string {
  if (at === null) return '—';
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const yes = (value: boolean) => (value ? 'yes' : 'no');

function deviceLines(d: DiagnosticsDevice): string[] {
  return [
    `  ${d.ref}${d.self ? ' (this device)' : ''} · ${d.platform} ${d.type}${d.osVersion ? ` ${d.osVersion}` : ''} · app ${d.appVersion ?? '—'}`,
    `    notifications ${d.notifications} · push token ${yes(d.pushToken)} · paused ${yes(d.paused)} · quiet hours ${d.quietHours}${d.quietHours === 'off' ? '' : d.quietAllowDecisions ? ' (decisions allowed)' : ' (nothing allowed)'}`,
    `    alerts for ${d.alertCategories.join(', ') || 'nothing'} · Time Sensitive ${yes(d.breakThroughFocus)} · last seen ${time(d.lastSeenAt)}`,
    `    last push ${d.lastPush ? `${d.lastPush.result} ${time(d.lastPush.at)}` : 'none'} · last receipt ${d.lastReceipt ? `${d.lastReceipt.result} ${time(d.lastReceipt.at)}` : 'none'}`,
  ];
}

function timings(t: DiagnosticsTimings): string {
  const reminder = t.reminderAfterSec === null ? 'off' : `${t.reminderAfterSec}s`;
  return `escalation ${t.escalationWaitSec}s, reminder ${reminder}, delay while present ${t.presenceDelaySec}s`;
}

function computerLines(c: DiagnosticsComputer): string[] {
  const { stored, effective } = c.timings;
  const same =
    stored.escalationWaitSec === effective.escalationWaitSec &&
    stored.reminderAfterSec === effective.reminderAfterSec &&
    stored.presenceDelaySec === effective.presenceDelaySec;
  const routes = Object.entries(c.routes)
    .map(([device, mode]) => `${device} ${mode}`)
    .join(', ');
  return [
    `  ${c.ref}${c.self ? ' (this computer)' : ''} · ${c.platform}${c.osVersion ? ` ${c.osVersion}` : ''}${c.arch ? ` ${c.arch}` : ''} · CLI ${c.cliVersion ?? '—'}`,
    `    paused ${yes(c.paused)} · project labels ${c.projectLabels} · last seen ${time(c.lastSeenAt)} · last alert ${time(c.lastAlertAt)}`,
    `    timings: ${timings(effective)}${same ? '' : ` (set: ${timings(stored)})`}`,
    `    routes: ${routes || 'none'}`,
    ...(c.hosts.length === 0
      ? ['    hosts: none reported']
      : c.hosts.map(
          (h) =>
            `    ${h.id}: hooks ${h.hooks} · finished turns ${yes(h.finished)} · MCP ${yes(h.mcp)} · skill ${yes(h.skill)} · last hook ${time(h.lastHookAt)}`,
        )),
  ];
}

function requestLine(r: DiagnosticsRequest): string {
  const what = `${r.kind}${r.reason ? `/${r.reason}` : ''} ${r.host}`;
  return `  ${r.ref} · ${r.computer} · ${what} · ${r.status}${r.status === 'pending' ? ` (${r.stage})` : ''}${r.paused ? ' · paused' : ''} · created ${time(r.createdAt)} · opened ${time(r.ackedAt)} · answered ${time(r.answeredAt)} · finished ${time(r.finishedAt)}`;
}

function testLine(t: DiagnosticsPushTest): string {
  const results = t.results
    .map((r) => `${r.device} ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
    .join(', ');
  return `  ${time(t.at)} · ${results || 'no devices'}`;
}
