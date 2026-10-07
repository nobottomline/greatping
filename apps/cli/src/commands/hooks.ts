import { loadConfig } from '../config';
import { HOST_IDS, inspectHost } from '../integrations';
import { HOSTS, installHooks, uninstallHooks } from '../integrations/host-hooks';
import { currentLauncher } from '../integrations/launcher';
import { nativeHost } from '../integrations/native-adapters';
import { reportMachineWithProgress } from '../report';
import { muted, print, ui } from '../ui';
import { hostSummary, parseHost } from './setup';
import { UsageError } from './usage';

/**
 * Hooks only, host by host. `greatping setup` is the usual way; this stays for
 * scripts and for turning finished-turn alerts on or off.
 */
export async function hooks(
  action: string | undefined,
  target: string | undefined,
  options: { finished?: boolean },
): Promise<number> {
  if (action === 'status' || action === undefined) {
    ui.heading('Hooks');
    const rows = HOST_IDS.flatMap((id): Array<[string, string]> => {
      const summary = hostSummary(id);
      return summary ? [[HOSTS[id].name, summary]] : [];
    });
    if (rows.length > 0) ui.rows(rows);
    else ui.info('Neither Claude Code nor Codex was found for this user.');
    print();
    return 0;
  }
  const only = parseHost(target, 'hooks');
  if (only && nativeHost(only))
    throw new UsageError('hooks', `Use greatping setup ${only} for its native adapter.`);
  const ids = only ? [only] : HOST_IDS.filter((id) => !nativeHost(id) && inspectHost(id).detected);
  if (action === 'install') {
    if (ids.length === 0) {
      ui.info('Neither Claude Code nor Codex was found for this user.');
      return 0;
    }
    for (const id of ids) {
      const host = HOSTS[id];
      if (inspectHost(id, true).plugin.status !== 'absent') {
        ui.error(
          `${host.name} has a native plugin registration. Use greatping setup ${id} to configure it; remove the plugin through its owner before installing direct hooks.`,
        );
        return 1;
      }
    }
    const launcher = currentLauncher();
    for (const id of ids) {
      const host = HOSTS[id];
      const finished = id === 'codex' ? true : (options.finished ?? inspectHost(id).hooks.finished);
      installHooks(host, launcher, finished);
      ui.success(`${host.name} will alert your devices when it needs you.`);
      ui.next(muted(host.activation));
    }
    ui.next(muted('Alerts are generic; question text and commands stay on this computer.'));
    await reportMachineWithProgress(loadConfig());
    return 0;
  }
  if (action === 'uninstall') {
    for (const id of ids) {
      const host = HOSTS[id];
      if (uninstallHooks(host)) ui.success(`Removed the GreatPing hooks from ${host.name}.`);
      else ui.info(`No GreatPing hooks were installed in ${host.name}.`);
    }
    await reportMachineWithProgress(loadConfig());
    return 0;
  }
  throw new UsageError('hooks', `Unknown action "${action}". Use install, uninstall or status.`);
}
