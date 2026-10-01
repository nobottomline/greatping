import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../config';

const assetSchema = z.object({
  kind: z.enum(['hooks', 'mcp', 'skill', 'backup', 'skills']),
  path: z.string(),
  host: z.enum(['claude', 'codex']).optional(),
  fingerprint: z.string().optional(),
  launcher: z.object({ command: z.string(), args: z.array(z.string()) }).optional(),
});
export type OwnedAsset = z.infer<typeof assetSchema>;
const schema = z.object({ version: z.literal(1), assets: z.array(assetSchema) });
export const ownershipPath = () => join(configDir(), 'installation.json');

/** A corrupt journal must never silently grant ownership or permit deletion. */
export function ownedAssets(): OwnedAsset[] {
  if (!existsSync(ownershipPath())) return [];
  return schema.parse(JSON.parse(readFileSync(ownershipPath(), 'utf8'))).assets;
}
function save(assets: OwnedAsset[]): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const temp = `${ownershipPath()}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, ownershipPath());
}
export function recordAsset(asset: OwnedAsset): void {
  save([...ownedAssets().filter((a) => a.kind !== asset.kind || a.path !== asset.path), asset]);
}
export function forgetAsset(kind: OwnedAsset['kind'], path: string): void {
  if (!existsSync(ownershipPath())) return;
  save(ownedAssets().filter((asset) => asset.kind !== kind || asset.path !== path));
}

/** Hash the entire owned tree, including links without following them. */
export function fingerprint(path: string): string {
  const digest = createHash('sha256');
  const walk = (file: string, relative: string) => {
    const info = lstatSync(file);
    digest.update(`${relative}\0`);
    if (info.isSymbolicLink()) digest.update(`link\0${readlinkSync(file)}`);
    else if (info.isDirectory()) {
      digest.update('dir\0');
      for (const name of readdirSync(file).sort()) walk(join(file, name), `${relative}/${name}`);
    } else if (info.isFile()) digest.update(readFileSync(file));
    else throw new Error(`Unsupported file type: ${file}`);
  };
  walk(path, '');
  return digest.digest('hex');
}
