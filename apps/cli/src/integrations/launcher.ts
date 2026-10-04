import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { detectInstallation } from '../installation';
import { supportsNodeVersion } from '../version';
import { findAllOnPath, findOnPath, isExecutable } from './executables';

export { findOnPath } from './executables';

/**
 * How another program (a host hook, an MCP client) starts this CLI. The
 * command must keep working after Node or GreatPing updates, so it prefers
 * stable entry points over the paths of the running process:
 *
 * 1. `greatping` on PATH when it is this installation (a global install): its
 *    bin link survives package updates.
 * 2. Otherwise a `node` on PATH that is not tied to one Node version (a
 *    version manager's shim, Homebrew's link) running this script, falling
 *    back to the running Node binary. Version managers put their versioned
 *    directory first on the PATH of child processes, so the first `node` found
 *    is often the one that disappears on the next Node update.
 */
export interface Launcher {
  command: string;
  args: string[];
}

/** Paths that belong to one installed Node version or one shell session. */
export function isVersionedPath(path: string): boolean {
  return /[/\\]v?\d+\.\d+\.\d+[/\\]|fnm_multishells/.test(path);
}

function realpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function nodeVersion(node: string): string | null {
  const result = spawnSync(node, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function currentLauncher(): Launcher {
  const script = process.argv[1] ? realpath(process.argv[1]) : null;
  if (!script) throw new Error('Could not locate the GreatPing executable.');
  const managed = detectInstallation(script).launcher;
  if (managed) return { command: managed, args: [] };
  const installed = findOnPath('greatping');
  if (installed && realpath(installed) === script) return { command: installed, args: [] };
  const stableNode = findAllOnPath('node')
    .filter((node) => !isVersionedPath(node))
    .find((node) => supportsNodeVersion(nodeVersion(node) ?? ''));
  return { command: stableNode ?? process.execPath, args: [script] };
}

/**
 * Whether a configured command can start: the executable exists and, when it
 * runs a script, the script exists too.
 */
export function launcherProblem(command: string, args: string[]): string | null {
  const executable = isAbsolute(command) ? command : findOnPath(command);
  if (!executable || !isExecutable(executable)) return `${command} is missing`;
  const script = args.find((arg) => /\.(c|m)?js$/.test(arg));
  if (script && !existsSync(script)) return `${script} is missing`;
  return null;
}

/** POSIX shell quoting for hosts that take a command string. */
export function shellCommand(parts: string[]): string {
  if (process.platform === 'win32') {
    return parts
      .map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
      .join(' ');
  }
  return parts
    .map((part) => (/^[\w./:@%+=,-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Splits a command string written by `shellCommand` back into its parts. */
export function parseShellCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    parts.push(
      match[1] !== undefined
        ? match[1].replace(/'\\''/g, "'")
        : match[2] !== undefined
          ? match[2].replace(/\\"/g, '"')
          : (match[3] ?? ''),
    );
  }
  return parts;
}
