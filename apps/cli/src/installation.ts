import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findAllOnPath, findOnPath } from './integrations/executables';

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'vite-plus' | 'volta';
export interface Installation {
  manager: Manager | 'local' | 'unknown';
  root: string | null;
  updateCommand: string | null;
  launcher: string | null;
  removal: { executable: string; args: string[]; probe: string[]; expected: string } | null;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function same(a: string, b: string): boolean {
  const path = real(a);
  return path !== null && path === real(b);
}
function inside(path: string, parent: string): boolean {
  const part = relative(real(parent) ?? resolve(parent), path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function json(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
// These strings are displayed, never evaluated by a shell.
function quote(value: string): string {
  return process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Filesystem evidence only: safe for help, notices and uninstall --dry-run. */
export function detectInstallation(
  script = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): Installation {
  const unknown: Installation = {
    manager: 'unknown',
    root: null,
    updateCommand: null,
    launcher: null,
    removal: null,
  };
  const entry = script && real(script);
  if (!entry) return unknown;
  const root = dirname(dirname(entry));
  const manifest = json(join(root, 'package.json'));
  const bin = manifest?.bin as Record<string, unknown> | undefined;
  if (
    manifest?.name !== 'greatping' ||
    typeof bin?.greatping !== 'string' ||
    !same(join(root, bin.greatping), entry)
  )
    return unknown;
  unknown.root = root;
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = env.PATH ?? '';
  const candidate = findOnPath('greatping', path);
  const launcher = candidate && same(candidate, entry) ? candidate : null;
  const owned = (
    manager: Manager,
    tool: string,
    update: string,
    args: string[],
    probe: string[],
    expected: string,
    stable = launcher,
  ): Installation => {
    const executable = findOnPath(tool, path);
    return {
      manager,
      root,
      updateCommand: update,
      launcher: stable,
      removal: executable ? { executable, args, probe, expected } : null,
    };
  };

  // Vite+ global packages are separate from npm's globals. Verify the recorded
  // install ID as well as the actual shared vp shim; a directory name alone is
  // not enough to authorize removal or a launcher that survives upgrades.
  let parent = root;
  for (let i = 0; i < 6; i++, parent = dirname(parent)) {
    if (basename(parent) !== 'greatping' || basename(dirname(parent)) !== 'packages') continue;
    const parts = relative(parent, root).split(sep);
    if (
      parts.length !== 4 ||
      parts[1] !== 'lib' ||
      parts[2] !== 'node_modules' ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(parts[0] ?? '')
    )
      continue;
    const metadata = json(`${parent}.json`);
    if (
      metadata?.name !== 'greatping' ||
      typeof metadata.installId !== 'string' ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(metadata.installId) ||
      metadata.version !== manifest.version ||
      !Array.isArray(metadata.bins) ||
      !metadata.bins.includes('greatping') ||
      !same(join(parent, metadata.installId, 'lib', 'node_modules', 'greatping'), root)
    )
      return unknown;
    const vp = findOnPath('vp', path);
    const stable = vp
      ? (findAllOnPath('greatping', path).find((bin) => same(bin, vp)) ?? null)
      : null;
    if (!stable) return unknown;
    return owned(
      'vite-plus',
      'vp',
      'vp install -g greatping@latest',
      ['uninstall', '-g', 'greatping'],
      [],
      `${parent}.json`,
      stable,
    );
  }
  const volta = env.VOLTA_HOME || join(home, '.volta');
  if (inside(root, join(volta, 'tools', 'image', 'packages'))) {
    const stable =
      candidate && resolve(candidate) === resolve(join(volta, 'bin', 'greatping'))
        ? candidate
        : null;
    return owned(
      'volta',
      'volta',
      'volta install greatping@latest',
      ['uninstall', 'greatping'],
      ['which', 'greatping'],
      entry,
      stable,
    );
  }
  const bun = env.BUN_INSTALL || join(home, '.bun');
  if (same(root, join(bun, 'install', 'global', 'node_modules', 'greatping')))
    return owned(
      'bun',
      'bun',
      'bun add --global greatping@latest',
      ['remove', '--global', 'greatping', '--ignore-scripts'],
      ['pm', 'bin', '--global'],
      entry,
    );
  const yarn =
    env.YARN_GLOBAL_FOLDER || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'yarn', 'global');
  if (same(root, join(yarn, 'node_modules', 'greatping')))
    return owned(
      'yarn',
      'yarn',
      'yarn global add greatping@latest',
      ['global', 'remove', 'greatping', '--ignore-scripts'],
      ['global', 'dir'],
      yarn,
    );
  const normalized = root.split(sep).join('/');
  if (
    /\/global\/[^/]+\/(?:.*\/)?node_modules\/greatping$/.test(normalized) &&
    (normalized.includes('/pnpm/') ||
      normalized.includes('/.pnpm/') ||
      Boolean(env.PNPM_HOME && inside(root, join(env.PNPM_HOME, 'global'))))
  ) {
    return owned(
      'pnpm',
      'pnpm',
      'pnpm add --global greatping@latest',
      ['remove', '--global', 'greatping', '--ignore-scripts'],
      ['root', '--global'],
      root,
    );
  }
  if (
    normalized.endsWith('/lib/node_modules/greatping') ||
    (process.platform === 'win32' &&
      same(
        root,
        join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', 'greatping'),
      ))
  ) {
    const prefix = normalized.endsWith('/lib/node_modules/greatping')
      ? dirname(dirname(dirname(root)))
      : dirname(dirname(root));
    return owned(
      'npm',
      'npm',
      `npm install --global --prefix ${quote(prefix)} greatping@latest`,
      ['uninstall', '--global', '--prefix', prefix, 'greatping', '--ignore-scripts'],
      ['root', '--global', '--prefix', prefix],
      dirname(root),
    );
  }
  if (existsSync(join(root, 'src')) || normalized.includes('/node_modules/'))
    return { ...unknown, manager: 'local', launcher };
  return unknown;
}

/** Read-only package-manager probe, bounded and without arbitrary log output. */
export async function verifyRemoval(installation: Installation): Promise<void> {
  const removal = installation.removal;
  if (!removal || !installation.root)
    throw new Error(
      'The package manager for this installation is unavailable. Restore it before uninstalling.',
    );
  // Re-read metadata and PATH just before any state is removed.
  const current = detectInstallation();
  if (
    current.root !== installation.root ||
    current.manager !== installation.manager ||
    current.removal?.executable !== removal.executable
  )
    throw new Error('The GreatPing installation changed. Run uninstall again.');
  if (installation.manager === 'vite-plus') return;
  const output = await managerOutput(removal.executable, removal.probe, 3000);
  const actual =
    installation.manager === 'pnpm' || installation.manager === 'bun'
      ? join(output, 'greatping')
      : output;
  if (!same(actual, removal.expected))
    throw new Error(
      'This package manager does not own the running GreatPing installation. Local state was preserved.',
    );
}

export function managerOutput(
  executable: string,
  args: string[],
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    if (batch && [executable, ...args].some((value) => /["%!^&|<>\r\n]/.test(value))) {
      reject(
        new Error(
          'This path cannot be passed safely to a Windows batch manager. Use the original manager manually.',
        ),
      );
      return;
    }
    const child = spawn(
      batch ? `"${executable}"` : executable,
      batch ? args.map((value) => `"${value}"`) : args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: batch,
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-8192);
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('The package-manager command timed out.'));
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not start the package manager.'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(output.trim());
      else
        reject(
          new Error(
            'The package-manager command failed. Retry using the original package manager.',
          ),
        );
    });
  });
}
