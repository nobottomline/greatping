import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export const DEFAULT_API_URL = 'https://greatping-api-dev.ueldo343.workers.dev';

export interface Config {
  apiUrl: string;
  machineId?: string;
  machineToken?: string;
}

export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (platform() === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.config'));
  return join(base, 'greatping');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** Server precedence: --server flag, GREATPING_API_URL, saved config, default. */
export function loadConfig(server?: string): Config {
  let saved: Partial<Config> = {};
  try {
    if (existsSync(configPath())) saved = JSON.parse(readFileSync(configPath(), 'utf-8'));
  } catch {
    saved = {};
  }
  const apiUrl = (
    server ||
    process.env.GREATPING_API_URL ||
    saved.apiUrl ||
    DEFAULT_API_URL
  ).replace(/\/+$/, '');
  return { ...saved, apiUrl };
}

/** Writes the config readable only by the current user; it holds the machine token. */
export function saveConfig(config: Config): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

export function isPaired(
  config: Config,
): config is Config & { machineId: string; machineToken: string } {
  return Boolean(config.machineId && config.machineToken);
}
