import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError, api } from '../api';
import { configDir, configPath, isPaired, loadConfig } from '../config';
import { HOST_IDS } from '../integrations';
import { findOnPath } from '../integrations/launcher';
import { ownershipPath } from '../integrations/ownership';
import {
  backupRemoval,
  executeRemoval,
  integrationRemoval,
  type RemovalAction,
  removeEmptyDirectory,
} from '../integrations/removal';
import { confirm, interactive, print, ui } from '../ui';
import { UsageError } from './usage';

interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  localOnly: boolean;
  json: boolean;
}

function globalPackage(): string | null {
  if (!process.argv[1]) return null;
  const script = realpathSync(process.argv[1]);
  const root = dirname(dirname(script));
  if (!root.endsWith(join('node_modules', 'greatping'))) return null;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return manifest.name === 'greatping' && !lstatSync(root).isSymbolicLink() ? root : null;
}
async function npm(args: string[]): Promise<string> {
  const command = findOnPath('npm');
  if (!command)
    throw new Error('npm is unavailable. Remove the CLI through its original package manager.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let output = '';
    // Do not expose arbitrary package-manager output, which can contain config.
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-8192);
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('npm removal timed out.'));
    }, 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error('npm failed. Remove the CLI through its original package manager.'));
    });
  });
}

export async function uninstall(options: UninstallOptions): Promise<number> {
  const config = loadConfig();
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
                await api(config, 'DELETE', '/machine/me', { signal: AbortSignal.timeout(5000) });
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
  const root = globalPackage();
  const binary: RemovalAction[] = root
    ? [
        {
          id: 'package',
          label: 'Remove the global GreatPing CLI through npm after verifying its installation',
          run: async () => {
            const modules = await npm(['root', '--global']);
            if (realpathSync(modules) !== realpathSync(dirname(root)))
              throw new Error(
                'This CLI is not owned by the active global npm installation. Use its original package manager to remove it.',
              );
            await npm(['uninstall', '--global', 'greatping', '--ignore-scripts']);
            if (existsSync(root)) throw new Error('The package manager left the CLI installed.');
          },
        },
      ]
    : [];
  const plan = [...actions, ...pairing, ...backups, ...local, ...binary];
  if (options.json && options.dryRun)
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, actions: plan.map(({ id, label, problem }) => ({ id, label, ...(problem ? { problem } : {}) })), package: root ? 'global' : 'checkout-or-external', serverRevocation: options.localOnly ? 'skipped' : isPaired(config) ? 'planned' : 'not-paired' })}\n`,
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
  const results = await executeRemoval([...actions, ...pairing, ...backups]);
  if (results.every((r) => r.status === 'removed')) {
    results.push(
      ...(await executeRemoval(local.filter((action) => action.id !== 'local:installation.json'))),
    );
    if (results.every((r) => r.status === 'removed')) {
      results.push(
        ...(await executeRemoval(
          local.filter((action) => action.id === 'local:installation.json'),
        )),
      );
    }
    if (results.every((r) => r.status === 'removed')) {
      results.push(
        ...(await executeRemoval([
          {
            id: 'local:directory',
            label: 'Remove the empty GreatPing config directory',
            run: () => removeEmptyDirectory(dir),
          },
        ])),
      );
    }
    if (results.every((r) => r.status === 'removed'))
      results.push(...(await executeRemoval(binary)));
  }
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
