import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { configDir } from '../config';
import { CLAUDE_ALERTS, type ClaudeAlert } from './events';
import { findOnPath, type Launcher, launcherProblem } from './launcher';
import { inspectNativeAdapter } from './native-adapters';
import type { HostId } from './state';

const ID = 'greatping@greatping';
export const pluginStatusSchema = z.enum([
  'absent',
  'disabled',
  'unconfigured',
  'ready',
  'broken',
  'unknown',
]);
const preferencesSchema = z.object({
  version: z.literal(1),
  launcher: z.object({ command: z.string().refine(isAbsolute), args: z.array(z.string()) }),
  finished: z.boolean(),
  alerts: z.array(z.enum(CLAUDE_ALERTS)),
});

export interface PluginState {
  status: z.infer<typeof pluginStatusSchema>;
  path: string | null;
  version: string | null;
  finished: boolean;
  alerts: ClaudeAlert[];
  problem: string | null;
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function json(path: string): Record<string, unknown> {
  // Never expose parser diagnostics: host files can contain credentials.
  const text = readFileSync(path, 'utf8');
  if (text.length > 1024 * 1024) throw new Error();
  return object(JSON.parse(text));
}

/** Read native registrations, never infer installation from a leftover cache.
 * Background reports never start host subprocesses or use the network.
 * Explicit diagnostics may ask Codex to disambiguate multiple cached versions.
 * Unknown schemas and ambiguous caches deliberately block automatic setup.
 */
export function inspectPlugin(host: HostId, native = false): PluginState {
  if (host === 'opencode' || host === 'pi' || host === 'cursor') return inspectNativeAdapter(host);
  let packageValid = false;
  const result: PluginState = {
    status: 'absent',
    path: null,
    version: null,
    finished: false,
    alerts: [],
    problem: null,
  };
  try {
    if (host === 'claude') {
      const inventory = join(claudeHome(), 'plugins/installed_plugins.json');
      const settings = join(claudeHome(), 'settings.json');
      const enabled = existsSync(settings) ? json(settings).enabledPlugins : undefined;
      const explicitlyEnabled = enabled ? object(enabled)[ID] : undefined;
      if (!existsSync(inventory)) {
        if (explicitlyEnabled !== undefined) throw new Error();
        return result;
      }
      const installed = json(inventory);
      if (installed.version !== 2) throw new Error();
      const entries = object(installed.plugins)[ID];
      if (entries === undefined) {
        if (explicitlyEnabled !== undefined) throw new Error();
        return result;
      }
      if (!Array.isArray(entries) || entries.length !== 1) throw new Error();
      const entry = object(entries[0]);
      if (
        entry.scope !== 'user' ||
        typeof entry.installPath !== 'string' ||
        !isAbsolute(entry.installPath)
      )
        throw new Error();
      result.path = entry.installPath;
      if (explicitlyEnabled === false) return { ...result, status: 'disabled' };
      if (explicitlyEnabled !== true) throw new Error();
    } else {
      const home = process.env.CODEX_HOME || join(homedir(), '.codex');
      const config = join(home, 'config.toml');
      if (!existsSync(config)) return result;
      const text = readFileSync(config, 'utf8');
      if (text.length > 1024 * 1024) throw new Error();
      const settings = parseToml(text);
      const plugins = settings.plugins ? object(settings.plugins) : {};
      const entry = plugins[ID];
      if (entry === undefined) return result;
      if (object(entry).enabled === false) return { ...result, status: 'disabled' };
      if (object(entry).enabled !== true) throw new Error();
      const cache = join(home, 'plugins/cache/greatping/greatping');
      const versions = existsSync(cache)
        ? readdirSync(cache, { withFileTypes: true }).filter((item) => item.isDirectory())
        : [];
      let version = versions.length === 1 ? versions[0]?.name : undefined;
      if (native && versions.length > 1) {
        const codex = findOnPath('codex');
        if (codex) {
          const inventory = spawnSync(codex, ['plugin', 'list', '--json'], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 1024 * 1024,
          });
          if (inventory.status === 0) {
            const installed = object(JSON.parse(inventory.stdout)).installed;
            if (!Array.isArray(installed)) throw new Error();
            const current = installed.map(object).filter((item) => item.pluginId === ID);
            const selected = current.length === 1 ? current[0] : undefined;
            if (
              typeof selected?.version === 'string' &&
              versions.some((item) => item.name === selected.version)
            )
              version = selected.version;
          }
        }
      }
      if (!version) {
        return {
          ...result,
          status: 'broken',
          problem:
            'Plugin cache is missing or ambiguous; inspect codex plugin list --json and reinstall through Codex.',
        };
      }
      result.path = join(cache, version);
    }
    result.status = 'broken';
    const manifest = json(
      join(result.path, host === 'claude' ? '.claude-plugin/plugin.json' : 'plugin.json'),
    );
    if (manifest.name !== 'greatping' || typeof manifest.version !== 'string') throw new Error();
    result.version = manifest.version;
    for (const file of [
      'scripts/bridge.mjs',
      'hooks/hooks.json',
      '.mcp.json',
      'skills/greatping/SKILL.md',
    ]) {
      if (!existsSync(join(result.path, file)))
        return {
          ...result,
          path: null,
          problem: 'Plugin package is incomplete; reinstall through its host manager.',
        };
    }
    packageValid = true;
    const preferences = join(configDir(), 'plugins', `${host}.json`);
    if (!existsSync(preferences))
      return { ...result, status: 'unconfigured', problem: `Run greatping setup ${host}.` };
    const parsed = preferencesSchema.safeParse(json(preferences));
    if (!parsed.success)
      return { ...result, problem: `Plugin preferences are invalid; run greatping setup ${host}.` };
    result.finished = parsed.data.finished;
    result.alerts = parsed.data.alerts;
    const problem = launcherProblem(parsed.data.launcher.command, parsed.data.launcher.args);
    if (problem)
      return { ...result, problem: `Plugin CLI launcher cannot run; run greatping setup ${host}.` };
    if (!findOnPath('node'))
      return { ...result, problem: 'Node.js must be available as node in the host environment.' };
    return { ...result, status: 'ready' };
  } catch {
    return {
      ...result,
      path: packageValid ? result.path : null,
      status: result.status === 'broken' ? 'broken' : 'unknown',
      problem:
        'Plugin registration or configuration cannot be verified. Inspect the native plugin manager and repair unreadable settings.',
    };
  }
}

/** Run only explicitly, during setup or diagnosis, through the installed package. */
export function pluginCommand(
  host: HostId,
  mode: 'configure' | 'check',
  launcher?: Launcher,
  finished?: boolean,
): string | null {
  const plugin = inspectPlugin(host, true);
  if (
    !plugin.path ||
    plugin.status === 'disabled' ||
    plugin.status === 'unknown' ||
    !existsSync(
      join(plugin.path, host === 'opencode' || host === 'pi' ? 'bridge.mjs' : 'scripts/bridge.mjs'),
    )
  )
    return plugin.problem ?? `Enable the GreatPing plugin in ${host} before configuring it.`;
  const args = [
    join(plugin.path, host === 'opencode' || host === 'pi' ? 'bridge.mjs' : 'scripts/bridge.mjs'),
    host,
    mode,
  ];
  if (launcher) {
    args.push('--command', launcher.command);
    for (const arg of launcher.args) args.push('--arg', arg);
  }
  if (finished !== undefined) args.push(finished ? '--finished' : '--no-finished');
  const node = mode === 'check' ? findOnPath('node') : process.execPath;
  if (!node) return 'Node.js must be available as node in the host environment.';
  const child = spawnSync(node, args, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 64 * 1024,
  });
  return child.status === 0
    ? null
    : child.stderr.trim() || 'Plugin launcher check failed. Run greatping setup for this host.';
}
