import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir } from '../config';
import { findOnPath, type Launcher, launcherProblem } from './launcher';
import { fingerprint, forgetAsset, ownedAssets, recordAsset } from './ownership';
import type { PluginState } from './plugins';

export type NativeHost = 'opencode' | 'pi' | 'cursor';
export function nativeHost(id: string): id is NativeHost {
  return id === 'opencode' || id === 'pi' || id === 'cursor';
}
export function nativeHome(id: NativeHost): string {
  if (id === 'cursor') return join(homedir(), '.cursor');
  return id === 'pi'
    ? process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
    : process.env.OPENCODE_CONFIG_DIR ||
        join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}
export const adapterPath = (id: NativeHost) =>
  id === 'cursor'
    ? join(nativeHome(id), 'plugins', 'local', 'greatping')
    : join(configDir(), 'adapters', id);
const entryPath = () => join(nativeHome('opencode'), 'plugins', 'greatping.js');
// Broken links are still user-owned entries, never permission to overwrite.
const assetExists = (path: string) => Boolean(lstatSync(path, { throwIfNoEntry: false }));
function piSources(): unknown[] {
  const file = join(nativeHome('pi'), 'settings.json');
  if (!existsSync(file)) return [];
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error();
  return settings.packages ?? [];
}
function isPiSource(item: unknown): boolean {
  const source =
    typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null && 'source' in item
        ? item.source
        : undefined;
  return (
    typeof source === 'string' &&
    !/^(npm:|git:|https?:)/.test(source) &&
    resolve(nativeHome('pi'), source) === adapterPath('pi')
  );
}
function registered(id: NativeHost): boolean {
  if (id === 'cursor') return assetExists(adapterPath(id));
  return id === 'opencode' ? assetExists(entryPath()) : piSources().some(isPiSource);
}
function checkOwned(kind: 'adapter' | 'adapter-entry', path: string): void {
  const asset = ownedAssets().find((item) => item.kind === kind && item.path === path);
  if (!asset || fingerprint(path) !== asset.fingerprint)
    throw new Error(
      'Adapter ownership is unknown or its files were changed; preserve it and use its installer.',
    );
}
export function inspectNativeAdapter(id: NativeHost): PluginState {
  const state: PluginState = {
    status: 'absent',
    path: null,
    version: null,
    finished: false,
    alerts: [],
    problem: null,
  };
  try {
    if (!registered(id)) {
      if (!assetExists(adapterPath(id))) return state;
      return {
        ...state,
        status: 'broken',
        problem:
          'Adapter files remain but the native registration is missing. Run setup to repair.',
      };
    }
    state.status = 'broken';
    checkOwned('adapter', adapterPath(id));
    if (id === 'opencode') checkOwned('adapter-entry', entryPath());
    else if (
      id === 'pi' &&
      piSources().some((item) => typeof item === 'object' && item !== null && isPiSource(item))
    )
      return {
        ...state,
        status: 'unknown',
        problem: 'Pi package filters are user-managed; inspect pi config before setup.',
      };
    state.path = adapterPath(id);
    state.version = JSON.parse(
      readFileSync(
        join(state.path, id === 'cursor' ? '.cursor-plugin/plugin.json' : 'package.json'),
        'utf8',
      ),
    ).version;
    const file = join(configDir(), 'plugins', `${id}.json`);
    if (!existsSync(file))
      return { ...state, status: 'unconfigured', problem: `Run greatping setup ${id}.` };
    const preferences = JSON.parse(readFileSync(file, 'utf8'));
    if (
      preferences.version !== 1 ||
      typeof preferences.finished !== 'boolean' ||
      !Array.isArray(preferences.alerts) ||
      preferences.alerts.some(
        (item: unknown) =>
          typeof item !== 'string' || !['questions', 'permissions', 'tool-input'].includes(item),
      ) ||
      !Array.isArray(preferences.launcher?.args) ||
      preferences.launcher.args.some((item: unknown) => typeof item !== 'string') ||
      typeof preferences.launcher?.command !== 'string' ||
      !isAbsolute(preferences.launcher.command)
    )
      throw new Error();
    state.finished = preferences.finished;
    state.alerts =
      id === 'cursor' ? [] : id === 'opencode' ? ['questions', 'permissions'] : ['tool-input'];
    state.problem = launcherProblem(preferences.launcher.command, preferences.launcher.args);
    state.status = state.problem ? 'broken' : 'ready';
    return state;
  } catch {
    return {
      ...state,
      status: 'broken',
      problem:
        'Native adapter registration, files or preferences cannot be verified. Repair through setup; modified files are preserved.',
    };
  }
}
function hostLauncher(id: NativeHost): Launcher | null {
  const command = findOnPath(id);
  if (!command) return null;
  // npm's Windows .cmd launcher cannot be spawned without a shell. Invoke
  // the verified package entrypoint directly; never interpolate into cmd.exe.
  if (/\.cmd$/i.test(command)) {
    const packageName = id === 'pi' ? '@earendil-works/pi-coding-agent' : 'opencode-ai';
    const root = join(dirname(command), 'node_modules', packageName);
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const entry = metadata.bin?.[id];
    const expected = id === 'pi' ? 'dist/bundle/cli.js' : 'bin/opencode.exe';
    if (metadata.name !== packageName || ![expected, `./${expected}`].includes(entry))
      throw new Error(`Unknown ${id} Windows launcher; use the supported npm installation.`);
    return id === 'pi'
      ? { command: process.execPath, args: [join(root, entry)] }
      : { command: join(root, entry), args: [] };
  }
  if (/\.(m|c)?js$/i.test(realpathSync(command)))
    return { command: process.execPath, args: [command] };
  return { command, args: [] };
}
function checkHostVersion(id: NativeHost): void {
  // Cursor IDE owns local-plugin policy and activation; its agent CLI is a
  // separate product and its version is not an IDE compatibility probe.
  if (id === 'cursor') return;
  const launcher = hostLauncher(id);
  // OpenCode's plugin files can be prepared before the host is installed.
  if (!launcher) return;
  const child = spawnSync(launcher.command, [...launcher.args, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
  });
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec((child.stdout ?? '').trim());
  const valid =
    match &&
    (id === 'opencode'
      ? Number(match[1]) === 1 &&
        (Number(match[2]) > 18 || (Number(match[2]) === 18 && Number(match[3]) >= 34))
      : Number(match[1]) === 0 &&
        (Number(match[2]) > 85 || (Number(match[2]) === 85 && Number(match[3]) >= 1)));
  if (child.status !== 0 || !valid)
    throw new Error(
      id === 'opencode'
        ? 'This adapter requires OpenCode >=1.18.34 and <2.0.0.'
        : 'This adapter requires Pi >=0.85.1 and <1.0.0.',
    );
}
export function nativeHostProblem(id: NativeHost): string | null {
  try {
    checkHostVersion(id);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Cannot verify the installed host version.';
  }
}
function piPackage(action: 'install' | 'remove'): void {
  const launcher = hostLauncher('pi');
  if (!launcher) throw new Error('The pi command must be installed and available on PATH.');
  const child = spawnSync(launcher.command, [...launcher.args, action, adapterPath('pi')], {
    stdio: 'ignore',
    timeout: 10000,
    env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
  });
  if (child.status !== 0)
    throw new Error(`pi ${action} failed; inspect the native package manager.`);
  if (registered('pi') !== (action === 'install'))
    throw new Error(`pi ${action} did not update the expected native package registration.`);
}
export function installNativeAdapter(id: NativeHost): void {
  checkHostVersion(id);
  const path = adapterPath(id);
  if (assetExists(path)) checkOwned('adapter', path);
  if (id === 'opencode' && assetExists(entryPath())) checkOwned('adapter-entry', entryPath());
  if (id === 'pi' && inspectNativeAdapter(id).status === 'unknown')
    throw new Error('Pi package filters are user-managed; use pi config to enable resources.');
  const here = dirname(fileURLToPath(import.meta.url));
  const source = [
    join(here, 'adapters', id, 'greatping'),
    join(here, '..', 'adapters', id, 'greatping'),
    join(here, '../../../../plugins', id, 'greatping'),
  ].find((file) =>
    existsSync(join(file, id === 'cursor' ? '.cursor-plugin/plugin.json' : 'package.json')),
  );
  if (!source) throw new Error('The bundled native adapter is missing from this CLI build.');
  mkdirSync(dirname(path), { recursive: true });
  cpSync(source, path, { recursive: true });
  recordAsset({ kind: 'adapter', host: id, path, fingerprint: fingerprint(path) });
  if (id === 'opencode') {
    mkdirSync(dirname(entryPath()), { recursive: true });
    writeFileSync(
      entryPath(),
      `export { default } from ${JSON.stringify(pathToFileURL(join(path, 'index.js')).href)};\n`,
    );
    recordAsset({
      kind: 'adapter-entry',
      host: id,
      path: entryPath(),
      fingerprint: fingerprint(entryPath()),
    });
  } else if (id === 'pi' && !registered(id)) piPackage('install');
}
export function removeNativeAdapter(id: NativeHost): void {
  const path = adapterPath(id);
  if (assetExists(path)) checkOwned('adapter', path);
  if (id === 'opencode' && assetExists(entryPath())) {
    checkOwned('adapter-entry', entryPath());
    rmSync(entryPath());
    forgetAsset('adapter-entry', entryPath());
  } else if (id === 'pi' && registered(id)) piPackage('remove');
  rmSync(path, { recursive: true, force: true });
  forgetAsset('adapter', path);
}
