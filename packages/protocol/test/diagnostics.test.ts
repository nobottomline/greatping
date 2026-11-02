import { describe, expect, it } from 'vitest';
import { formatDiagnostics } from '../src/diagnostics';
import type { DiagnosticsReport } from '../src/index';

const at = Date.parse('2026-10-16T15:04:00Z');

const report: DiagnosticsReport = {
  schemaVersion: 1,
  scope: 'account',
  generatedAt: at,
  plan: { tier: 'free', computerLimit: 1, customTimings: false, historyDays: 7 },
  devices: [
    {
      ref: 'D1',
      self: true,
      platform: 'ios',
      type: 'phone',
      osVersion: '26.1',
      appVersion: '1.0.0',
      notifications: 'enabled',
      pushToken: true,
      alertCategories: ['decision', 'question'],
      breakThroughFocus: true,
      paused: false,
      quietHours: 'now',
      quietAllowDecisions: true,
      lastSeenAt: at,
      lastPush: { at, result: 'accepted' },
      lastReceipt: { at, result: 'InvalidCredentials' },
    },
  ],
  computers: [
    {
      ref: 'C1',
      self: false,
      platform: 'darwin',
      osVersion: '15.1',
      arch: 'arm64',
      cliVersion: '0.5.2',
      hosts: [
        { id: 'claude-code', hooks: 'ok', finished: true, mcp: true, skill: false, lastHookAt: at },
      ],
      lastSeenAt: at,
      lastAlertAt: null,
      paused: false,
      timings: {
        stored: { escalationWaitSec: 300, reminderAfterSec: 900, presenceDelaySec: 30 },
        effective: { escalationWaitSec: 90, reminderAfterSec: 300, presenceDelaySec: 30 },
      },
      projectLabels: 'hidden',
      routes: { D1: 'first' },
    },
  ],
  requests: [
    {
      ref: 'R1',
      computer: 'C1',
      kind: 'attention',
      host: 'claude-code',
      reason: 'permission',
      status: 'pending',
      stage: 'primary',
      paused: false,
      createdAt: at,
      ackedAt: null,
      answeredAt: null,
      finishedAt: null,
    },
  ],
  pushTests: [{ at, results: [{ device: 'D1', status: 'failed', reason: 'credentials' }] }],
  truncated: false,
};

describe('formatDiagnostics', () => {
  it('reads as plain text with UTC times and report references', () => {
    const text = formatDiagnostics(report, ['GreatPing 1.0.0 (30)']);
    expect(text).toContain('Generated 2026-10-16 15:04 UTC · from a device · format 1');
    expect(text).toContain('  GreatPing 1.0.0 (30)');
    expect(text).toContain('Plan: free · up to 1 computer · custom timings no · history 7 days');
    expect(text).toContain('  D1 (this device) · ios phone 26.1 · app 1.0.0');
    expect(text).toContain('quiet hours now (decisions allowed)');
    expect(text).toContain(
      'last push accepted 2026-10-16 15:04 UTC · last receipt InvalidCredentials 2026-10-16 15:04 UTC',
    );
    // The timings that apply, and what was set when they differ (Pro ended).
    expect(text).toContain(
      'timings: escalation 90s, reminder 300s, delay while present 30s (set: escalation 300s, reminder 900s, delay while present 30s)',
    );
    expect(text).toContain('routes: D1 first');
    expect(text).toContain('claude-code: hooks ok · finished turns yes · MCP yes · skill no');
    expect(text).toContain('R1 · C1 · attention/permission claude-code · pending (primary)');
    expect(text).toContain('D1 failed (credentials)');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('says when nothing is there and when the report was shortened', () => {
    const text = formatDiagnostics({
      ...report,
      scope: 'computer',
      devices: [],
      computers: [],
      requests: [],
      pushTests: [],
      truncated: true,
    });
    expect(text).toContain('from a computer');
    expect(text).not.toContain('Devices');
    expect(text).toContain('Computers\n  none');
    expect(text).toContain('Latest alerts (0)\n  none');
    expect(text).toContain('Some devices, computers or alerts were left out.');
  });
});
