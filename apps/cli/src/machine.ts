import { execFileSync } from 'node:child_process';
import { hostname, platform } from 'node:os';
import process from 'node:process';
import type { Machine } from '@greatping/protocol';

/**
 * The name people know their computer by: "Alex's MacBook Pro" rather
 * than the network host name "MacBook-Pro-Alex.local".
 */
export function computerName(): string {
  let name = '';
  try {
    if (platform() === 'darwin') {
      name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
    } else if (platform() === 'win32') {
      name = process.env.COMPUTERNAME ?? '';
    } else {
      name = execFileSync('hostnamectl', ['--pretty'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
    }
  } catch {
    name = '';
  }
  if (!name) name = hostname().replace(/\.local$/, '');
  return name.slice(0, 100) || 'Computer';
}

export function machinePlatform(): Machine['platform'] {
  const current = platform();
  if (current === 'darwin' || current === 'win32' || current === 'linux') return current;
  return 'other';
}
