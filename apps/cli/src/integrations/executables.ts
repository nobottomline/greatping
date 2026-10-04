import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every executable named `name` on PATH, in order, like `which -a`. */
export function findAllOnPath(name: string, path = process.env.PATH ?? ''): string[] {
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  const found: string[] = [];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (isExecutable(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

export function findOnPath(name: string, path = process.env.PATH ?? ''): string | null {
  return findAllOnPath(name, path)[0] ?? null;
}
