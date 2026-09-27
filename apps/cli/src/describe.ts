import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import type { HostIntegration, ReportMachineBody } from '@greatping/protocol';
import { legacyIntegrations } from './integrations';

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
  } catch {
    return '';
  }
}

/** Human-readable OS name and version, e.g. "macOS 26.0" or "Ubuntu 24.04.1 LTS". */
export function osVersion(): string | null {
  const current = platform();
  if (current === 'darwin') {
    const version = run('sw_vers', ['-productVersion']);
    return version ? `macOS ${version}` : null;
  }
  if (current === 'linux') {
    try {
      const match = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?$/m);
      if (match?.[1]) return match[1].slice(0, 60);
    } catch {
      // Fall through to the kernel release.
    }
    return `Linux ${release()}`;
  }
  if (current === 'win32') return `Windows ${release()}`;
  return null;
}

/**
 * What this computer tells its account's devices about itself: no user names,
 * paths, network addresses or hardware identifiers.
 */
export function describeMachine(state: {
  cliVersion: string;
  hosts: HostIntegration[];
}): ReportMachineBody {
  const os = osVersion();
  return {
    ...(os ? { osVersion: os } : {}),
    arch: arch(),
    cliVersion: state.cliVersion,
    integrations: legacyIntegrations(state.hosts),
    hosts: state.hosts,
  };
}
