import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { UsageError } from './commands/usage';

// Keep this aligned with the mobile preview. Production rollout is a separate release.
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

/** The service is built in. A saved URL binds an existing credential to its issuer. */
export function loadConfig(): Config {
  let saved: Record<string, unknown> = {};
  try {
    if (existsSync(configPath())) {
      const value: unknown = JSON.parse(readFileSync(configPath(), 'utf-8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        saved = value as Record<string, unknown>;
      }
    }
  } catch {
    // An unreadable config is treated as unpaired; never infer a credential's issuer.
  }
  const machineId = typeof saved.machineId === 'string' ? saved.machineId : undefined;
  const machineToken = typeof saved.machineToken === 'string' ? saved.machineToken : undefined;
  const paired = Boolean(machineId && machineToken);
  const apiUrl = paired
    ? typeof saved.apiUrl === 'string'
      ? saved.apiUrl.trim().replace(/\/+$/, '')
      : ''
    : DEFAULT_API_URL;
  return machineId && machineToken ? { apiUrl, machineId, machineToken } : { apiUrl };
}

/** Never send an existing credential to another environment or a config-supplied host. */
export function requireServer(config: Config): void {
  if (config.apiUrl === DEFAULT_API_URL) return;
  throw new UsageError(
    null,
    'This pairing belongs to a different or unknown GreatPing environment.',
    'Run greatping logout, then greatping login to pair with this version of GreatPing.',
  );
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
