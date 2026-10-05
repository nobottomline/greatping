import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, inspectHooks, uninstallHooks } from './host-hooks';
import { readJson, writeJson } from './json-file';
import {
  canonicalSkillPath,
  checkManagedSkill,
  managedSkillInstalled,
  removeManagedSkill,
} from './managed-skills';
import { codexConfig, codexMcpServer, mcpInvocationOwned, unregisterCodexMcp } from './mcp';
import { fingerprint, forgetAsset, ownedAssets } from './ownership';
import { checkSkillRemoval, skillDir, skillInstalled, uninstallSkill } from './skill';
import type { HostId } from './state';

export interface RemovalAction {
  id: string;
  label: string;
  problem?: string;
  run(): void | Promise<void>;
}
export interface RemovalOutcome {
  id: string;
  label: string;
  status: 'removed' | 'failed';
  error?: string;
}

export function integrationRemoval(ids: HostId[], full = false): RemovalAction[] {
  const actions: RemovalAction[] = [];
  const assets = ownedAssets();
  for (const id of ids) {
    const paths = new Set([
      HOSTS[id].settingsPath(),
      ...assets.filter((a) => a.kind === 'hooks' && a.host === id).map((a) => a.path),
    ]);
    for (const path of paths) {
      const host = { ...HOSTS[id], settingsPath: () => path };
      const state = inspectHooks(host);
      if (state.status !== 'off')
        actions.push({
          id: `hooks:${path}`,
          label: `Remove GreatPing hooks from ${path}`,
          run: () => {
            uninstallHooks(host);
            if (inspectHooks(host).status !== 'off')
              throw new Error('GreatPing hooks remain or settings are unreadable.');
          },
        });
    }
    if (id === 'codex') {
      const mcpPaths = new Set([
        codexConfig(),
        ...assets
          .filter((asset) => asset.kind === 'mcp' && asset.host === 'codex')
          .map((asset) => asset.path),
      ]);
      for (const path of mcpPaths) {
        if (existsSync(path) && codexMcpServer(readFileSync(path, 'utf8')))
          actions.push({
            id: `mcp:${path}`,
            label: `Remove GreatPing MCP from ${path}`,
            run: () => {
              if (!unregisterCodexMcp(path))
                throw new Error(
                  'Could not remove Codex MCP. Check ownership and the codex command on PATH.',
                );
            },
          });
      }
    }
    if (id === 'claude') {
      const path = join(homedir(), '.claude.json');
      const settings = readJson(path);
      const servers = settings.mcpServers as
        | Record<string, { command?: string; args?: string[] }>
        | undefined;
      const own = servers?.greatping;
      if (own)
        actions.push({
          id: `mcp:${path}`,
          label: 'Remove GreatPing MCP from Claude Code',
          run: () => {
            const fresh = readJson(path),
              mcp = fresh.mcpServers as Record<string, { command?: string; args?: string[] }>;
            const current = mcp?.greatping;
            if (!current) return;
            if (!mcpInvocationOwned(current.command ?? '', current.args ?? [], path))
              throw new Error('The Claude MCP entry has unknown ownership.');
            const { greatping: _removed, ...kept } = mcp;
            writeJson(path, { ...fresh, mcpServers: kept }, { backup: false });
            forgetAsset('mcp', path);
          },
        });
    }
  }
  const managed = managedSkillInstalled();
  if (managed) {
    let problem: string | undefined;
    try {
      checkManagedSkill();
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Cannot verify the managed skill.';
    }
    actions.push({
      id: 'skills:global',
      ...(problem ? { problem } : {}),
      label:
        full || ids.length > 1
          ? 'Remove the GreatPing skill through npx skills from all agents'
          : `Remove the GreatPing skill through npx skills for ${ids[0]}`,
      run: () =>
        removeManagedSkill(
          full || ids.length > 1 ? undefined : ids[0] === 'claude' ? 'claude-code' : 'codex',
        ),
    });
  }
  for (const id of ids) {
    const path = skillDir(id);
    if (
      (skillInstalled(id) ||
        assets.some((asset) => asset.kind === 'skill' && asset.path === path)) &&
      !(managed && (path === canonicalSkillPath() || lstatSync(path).isSymbolicLink()))
    ) {
      let problem: string | undefined;
      try {
        checkSkillRemoval(id);
      } catch (error) {
        problem = error instanceof Error ? error.message : 'Cannot verify the skill.';
      }
      actions.push({
        ...(problem ? { problem } : {}),
        id: `skill:${path}`,
        label: `Remove the bundled GreatPing skill from ${path}`,
        run: () => {
          uninstallSkill(id);
        },
      });
    }
  }
  return actions;
}

export async function executeRemoval(
  actions: RemovalAction[],
  options: { signal?: AbortSignal; onAction?: (label: string) => void } = {},
): Promise<RemovalOutcome[]> {
  const results: RemovalOutcome[] = [];
  for (const action of actions) {
    options.signal?.throwIfAborted();
    options.onAction?.(action.label);
    try {
      await action.run();
      options.signal?.throwIfAborted();
      results.push({ id: action.id, label: action.label, status: 'removed' });
    } catch (error) {
      options.signal?.throwIfAborted();
      results.push({
        id: action.id,
        label: action.label,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Removal failed.',
      });
    }
  }
  return results;
}

/** Only unchanged, journaled backups; never restore over subsequent user edits. */
export function backupRemoval(): RemovalAction[] {
  return ownedAssets()
    .filter((asset) => asset.kind === 'backup' && existsSync(asset.path))
    .map((asset) => ({
      id: `backup:${asset.path}`,
      label: `Remove GreatPing’s backup ${asset.path}`,
      run: () => {
        if (fingerprint(asset.path) !== asset.fingerprint)
          throw new Error('The backup was modified; it was preserved.');
        rmSync(asset.path);
        forgetAsset('backup', asset.path);
      },
    }));
}

export function removeEmptyDirectory(path: string): void {
  if (
    existsSync(path) &&
    lstatSync(path).isDirectory() &&
    !lstatSync(path).isSymbolicLink() &&
    readdirSync(path).length === 0
  )
    rmSync(path, { recursive: true });
}
