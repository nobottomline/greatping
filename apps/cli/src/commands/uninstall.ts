import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, api } from '../api';
import { configDir, configPath, isPaired, loadConfig } from '../config';
import { detectInstallation, managerOutput, verifyRemoval } from '../installation';
import { HOST_IDS } from '../integrations';
import { ownershipPath } from '../integrations/ownership';
import {
  backupRemoval,
  executeRemoval,
  integrationRemoval,
  type RemovalAction,
  removeEmptyDirectory,
} from '../integrations/removal';
import { CommandInterrupted, withProgress } from '../progress';
import { confirm, interactive, print, ui } from '../ui';
import { UsageError } from './usage';

interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  localOnly: boolean;
  json: boolean;
}

export async function uninstall(options: UninstallOptions): Promise<number> {
  const config = loadConfig();
  let removalSignal: AbortSignal | undefined;
  let pairingUnknown = false;
  if (existsSync(configPath())) {
    try {
      const saved = JSON.parse(readFileSync(configPath(), 'utf8'));
      pairingUnknown =
        !saved ||
        typeof saved !== 'object' ||
        Array.isArray(saved) ||
        (Boolean(saved.machineToken || saved.machineId) && !isPaired(config));
    } catch {
      pairingUnknown = true;
    }
  }
  const actions = integrationRemoval(HOST_IDS, true);
  const pairing: RemovalAction[] =
    isPaired(config) && !options.localOnly
      ? [
          {
            id: 'pairing',
            label: 'Unpair this computer and revoke its server credential',
            run: async () => {
              try {
                await api(config, 'DELETE', '/machine/me', {
                  signal: removalSignal
                    ? AbortSignal.any([removalSignal, AbortSignal.timeout(5000)])
                    : AbortSignal.timeout(5000),
                });
              } catch (error) {
                if (!(error instanceof ApiError && error.status === 401)) throw error;
              }
            },
          },
        ]
      : pairingUnknown && !options.localOnly
        ? [
            {
              id: 'pairing',
              label: 'Resolve unreadable or incomplete pairing before removal',
              problem:
                'Pairing cannot be verified. Repair the credential file or explicitly use --local-only and unpair in the app.',
              run: () => {
                throw new Error('Pairing is unknown; server revocation cannot be confirmed.');
              },
            },
          ]
        : [];
  const backups = backupRemoval();
  const dir = configDir();
  const local: RemovalAction[] = [
    'config.json',
    'setup-options.json',
    'update-check.json',
    'hook-state',
    'installation.json',
  ]
    .filter((name) => existsSync(join(dir, name)))
    .map((name) => ({
      id: `local:${name}`,
      label: `Remove GreatPing local ${name}`,
      run: () => {
        rmSync(join(dir, name), { recursive: name === 'hook-state', force: true });
      },
    }));
  // Keep the journal until every earlier removal has succeeded.
  local.sort(
    (a, b) =>
      Number(a.id.endsWith('installation.json')) - Number(b.id.endsWith('installation.json')),
  );
  const installation = detectInstallation();
  const managed = !['local', 'unknown'].includes(installation.manager);
  const root = managed ? installation.root : null;
  const binary: RemovalAction[] = root
    ? [
        {
          id: 'package',
          label: `Remove the global GreatPing CLI through ${installation.manager}`,
          ...(!installation.removal
            ? { problem: 'The original package manager is unavailable.' }
            : {}),
          run: async () => {
            await verifyRemoval(installation, removalSignal);
            const removal = installation.removal;
            if (!removal) throw new Error('The original package manager is unavailable.');
            await managerOutput(removal.executable, removal.args, 30000, removalSignal);
            if (existsSync(root)) throw new Error('The package manager left the CLI installed.');
          },
        },
      ]
    : [];
  const plan = [...actions, ...pairing, ...backups, ...local, ...binary];
  if (options.json && options.dryRun)
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, actions: plan.map(({ id, label, problem }) => ({ id, label, ...(problem ? { problem } : {}) })), package: root ? 'global' : 'checkout-or-external', packageManager: installation.manager, serverRevocation: options.localOnly ? 'skipped' : isPaired(config) ? 'planned' : 'not-paired' })}\n`,
    );
  ui.heading(options.dryRun ? 'GreatPing removal plan' : 'Uninstall GreatPing');
  for (const action of plan) {
    print(`  • ${action.label}`);
    if (action.problem) ui.warn(action.problem);
  }
  if (options.localOnly && (isPaired(config) || pairingUnknown))
    ui.warn(
      'Local-only removal leaves the server credential valid. Unpair this computer in the app.',
    );
  if (!root)
    ui.info(
      'The running CLI is a checkout or an external installation. Its source/package is preserved; use the original package manager if needed.',
    );
  if (options.dryRun) {
    ui.info('Dry run: nothing was changed and no network or package-manager commands were run.');
    return 0;
  }
  if (plan.length && !options.yes) {
    if (!interactive)
      throw new UsageError('uninstall', 'Use --yes to confirm removal non-interactively.');
    if (!(await confirm('Remove these GreatPing components?', false))) {
      ui.info('Nothing changed.');
      return Number(process.exitCode ?? 0);
    }
  }
  // Check the owner before revoking a credential or touching integrations.
  if (root) {
    try {
      await withProgress(
        'Checking package ownership',
        (signal) => verifyRemoval(installation, signal),
        {
          json: options.json,
          interrupted: 'Ownership check interrupted. No removal was started.',
        },
      );
    } catch (error) {
      if (error instanceof CommandInterrupted) throw error;
      const message =
        error instanceof Error ? error.message : 'Could not verify the package manager.';
      ui.error(message);
      if (options.json)
        process.stdout.write(
          `${JSON.stringify({
            dryRun: false,
            complete: false,
            results: [{ id: 'package', label: binary[0]?.label, status: 'failed', error: message }],
            serverRevocation: 'not-attempted',
          })}\n`,
        );
      return 1;
    }
  }
  const results = await withProgress(
    'Removing GreatPing',
    async (signal, update) => {
      removalSignal = signal;
      const remove = (actions: RemovalAction[]) =>
        executeRemoval(actions, { signal, onAction: update });
      const results = await remove([...actions, ...pairing, ...backups]);
      if (results.every((r) => r.status === 'removed')) {
        results.push(
          ...(await remove(local.filter((action) => action.id !== 'local:installation.json'))),
        );
        if (results.every((r) => r.status === 'removed')) results.push(...(await remove(binary)));
        if (results.every((r) => r.status === 'removed')) {
          results.push(
            ...(await remove(local.filter((action) => action.id === 'local:installation.json'))),
          );
          results.push(
            ...(await remove([
              {
                id: 'local:directory',
                label: 'Remove the empty GreatPing config directory',
                run: () => removeEmptyDirectory(dir),
              },
            ])),
          );
        }
      }
      return results;
    },
    {
      json: options.json,
      interrupted:
        'Removal interrupted. Some changes may already be applied; rerun greatping uninstall to finish.',
    },
  );
  for (const result of results) {
    if (result.status === 'failed') ui.error(result.label, result.error);
    else ui.success(result.label);
  }
  const failed = results.some((r) => r.status === 'failed');
  if (failed)
    ui.warn(
      `Removal is incomplete. Local recovery information was kept when possible. Fix the reported problem and run greatping uninstall again. Journal: ${ownershipPath()}`,
    );
  else ui.success('GreatPing’s detected integrations and local state were removed.');
  if (options.json)
    process.stdout.write(
      `${JSON.stringify({ dryRun: false, complete: !failed, results, serverRevocation: options.localOnly ? 'skipped' : pairing.length ? (results.find((r) => r.id === 'pairing')?.status === 'removed' ? 'revoked' : 'failed') : 'not-paired' })}\n`,
    );
  return failed ? 1 : 0;
}
