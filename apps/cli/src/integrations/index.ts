import type { HostIntegration } from '@greatping/protocol';
import { HOSTS, type HooksState, type HostHooks, inspectHooks } from './host-hooks';
import { inspectMcp, type McpState } from './mcp';
import { inspectPlugin, type PluginState } from './plugins';
import { skillInstalled } from './skill';
import { type AlertAttempt, type HostId, lastAlert, lastHookAt } from './state';

export const HOST_IDS: HostId[] = ['claude', 'codex', 'opencode', 'pi', 'cursor'];

/** The id devices know a host by. */
export const PROTOCOL_ID: Record<HostId, string> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  cursor: 'cursor',
};

export interface HostReport {
  host: HostHooks;
  detected: boolean;
  hooks: HooksState;
  mcp: McpState;
  skill: boolean;
  lastHookAt: number | null;
  lastAlert: AlertAttempt | null;
  plugin: PluginState;
  conflicts: string[];
}

export function inspectHost(id: HostId, native = false): HostReport {
  const host = HOSTS[id];
  const hooks = inspectHooks(host);
  const mcp = inspectMcp(id);
  const skill = skillInstalled(id);
  const plugin = inspectPlugin(id, native);
  return {
    host,
    detected: host.detected(),
    hooks,
    mcp,
    skill,
    plugin,
    conflicts:
      plugin.status === 'absent'
        ? []
        : [
            ...(hooks.status !== 'off' ? ['direct CLI hooks (plugin hooks stand by)'] : []),
            ...(mcp.registered ? ['separate GreatPing MCP registration'] : []),
            ...(skill ? ['separate GreatPing skill'] : []),
          ],
    lastHookAt: lastHookAt(id),
    lastAlert: lastAlert(id),
  };
}

/** A report worth showing: the host is here or GreatPing set something up for it. */
export function relevant(report: HostReport): boolean {
  return (
    report.detected ||
    report.hooks.status !== 'off' ||
    report.mcp.registered ||
    report.skill ||
    report.plugin.status !== 'absent'
  );
}

export function toHostIntegration(report: HostReport): HostIntegration {
  const plugin = report.plugin;
  const ready = plugin.status === 'ready';
  const pluginAlerts =
    ready &&
    (report.host.id !== 'codex' ? plugin.alerts.length > 0 || plugin.finished : plugin.finished);
  const pluginBroken = ['broken', 'unconfigured', 'unknown'].includes(plugin.status);
  const hooks =
    report.hooks.status === 'off'
      ? pluginAlerts
        ? 'ok'
        : pluginBroken
          ? 'broken'
          : 'off'
      : report.hooks.status === 'broken'
        ? 'broken'
        : 'ok';
  return {
    id: PROTOCOL_ID[report.host.id],
    // Outdated hooks still alert for what they cover; devices only need to
    // know whether alerts work, `doctor` explains the rest.
    hooks,
    // Codex hooks exist only to alert at the end of a turn.
    finished:
      report.hooks.status !== 'off'
        ? report.host.id === 'codex' || report.hooks.finished
        : ready && plugin.finished,
    mcp: report.mcp.registered ? report.mcp.problem === null : ready,
    skill: report.skill || ready,
    lastHookAt: report.lastHookAt,
  };
}

/** Local detail; package paths and host configuration never enter device reports. */
export function pluginDiagnostics(native = false) {
  return HOST_IDS.map((id) => inspectHost(id, native))
    .filter(relevant)
    .map((report) => {
      const { path: _path, ...plugin } = report.plugin;
      return {
        id: report.host.id,
        ...plugin,
        conflicts: report.conflicts,
        hookTrust: 'host-managed' as const,
        lastAlert: report.lastAlert,
      };
    });
}

/** What the computer tells its devices about its agent hosts. */
export function hostIntegrations(native = false): HostIntegration[] {
  return HOST_IDS.map((id) => inspectHost(id, native))
    .filter(relevant)
    .map(toHostIntegration);
}

/** The older flat list, kept for apps that predate per-host detail. */
export function legacyIntegrations(hosts: HostIntegration[]): string[] {
  return hosts.filter((host) => host.hooks !== 'off' || host.mcp).map((host) => host.id);
}
