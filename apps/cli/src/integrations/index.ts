import type { HostIntegration } from '@greatping/protocol';
import { HOSTS, type HooksState, type HostHooks, inspectHooks } from './host-hooks';
import { inspectMcp, type McpState } from './mcp';
import { skillInstalled } from './skill';
import { type HostId, lastHookAt } from './state';

export const HOST_IDS: HostId[] = ['claude', 'codex'];

/** The id devices know a host by. */
export const PROTOCOL_ID: Record<HostId, string> = { claude: 'claude-code', codex: 'codex' };

export interface HostReport {
  host: HostHooks;
  detected: boolean;
  hooks: HooksState;
  mcp: McpState;
  skill: boolean;
  lastHookAt: number | null;
}

export function inspectHost(id: HostId): HostReport {
  const host = HOSTS[id];
  return {
    host,
    detected: host.detected(),
    hooks: inspectHooks(host),
    mcp: inspectMcp(id),
    skill: skillInstalled(id),
    lastHookAt: lastHookAt(id),
  };
}

/** A report worth showing: the host is here or GreatPing set something up for it. */
function relevant(report: HostReport): boolean {
  return report.detected || report.hooks.status !== 'off' || report.mcp.registered || report.skill;
}

export function toHostIntegration(report: HostReport): HostIntegration {
  return {
    id: PROTOCOL_ID[report.host.id],
    // Outdated hooks still alert for what they cover; devices only need to
    // know whether alerts work, `doctor` explains the rest.
    hooks:
      report.hooks.status === 'off' ? 'off' : report.hooks.status === 'broken' ? 'broken' : 'ok',
    // Codex hooks exist only to alert at the end of a turn.
    finished: report.host.id === 'codex' ? report.hooks.status !== 'off' : report.hooks.finished,
    mcp: report.mcp.registered && report.mcp.problem === null,
    skill: report.skill,
    lastHookAt: report.lastHookAt,
  };
}

/** What the computer tells its devices about its agent hosts. */
export function hostIntegrations(): HostIntegration[] {
  return HOST_IDS.map(inspectHost).filter(relevant).map(toHostIntegration);
}

/** The older flat list, kept for apps that predate per-host detail. */
export function legacyIntegrations(hosts: HostIntegration[]): string[] {
  return hosts.filter((host) => host.hooks !== 'off' || host.mcp).map((host) => host.id);
}
