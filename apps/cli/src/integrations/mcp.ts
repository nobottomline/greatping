import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { parse as parseToml } from 'smol-toml';
import { findOnPath, type Launcher, launcherProblem } from './launcher';
import { forgetAsset, ownedAssets, recordAsset } from './ownership';
import type { HostId } from './state';

/**
 * GreatPing's MCP server (`greatping mcp`) as registered with a host. Codex
 * needs it most: its sandbox usually blocks the network for shell commands,
 * while MCP servers run outside the sandbox.
 */

export interface McpState {
  registered: boolean;
  problem: string | null;
}

export function codexConfig(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
}

/** Reads `command` and `args` of `[mcp_servers.greatping]` from Codex's TOML. */
export function codexMcpServer(toml: string): { command: string; args: string[] } | null {
  try {
    const settings = parseToml(toml);
    const servers = settings.mcp_servers as Record<string, unknown> | undefined;
    const server = servers?.greatping as { command?: unknown; args?: unknown } | undefined;
    if (!server) return null;
    return {
      command: typeof server.command === 'string' ? server.command : '',
      args:
        Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string')
          ? server.args
          : [],
    };
  } catch {
    return null;
  }
}

export function inspectMcp(host: HostId): McpState {
  if (host === 'cursor') {
    try {
      const servers = JSON.parse(
        readFileSync(join(homedir(), '.cursor', 'mcp.json'), 'utf8'),
      ).mcpServers;
      return { registered: Boolean(servers?.greatping), problem: null };
    } catch {
      return { registered: false, problem: null };
    }
  }
  if (host === 'opencode' || host === 'pi') return { registered: false, problem: null };
  if (host === 'codex') {
    let toml: string;
    try {
      toml = readFileSync(codexConfig(), 'utf8');
    } catch {
      return { registered: false, problem: null };
    }
    const server = codexMcpServer(toml);
    if (!server) return { registered: false, problem: null };
    return { registered: true, problem: launcherProblem(server.command, server.args) };
  }
  try {
    const config = JSON.parse(readFileSync(claudeMcpConfig(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return { registered: Boolean(config.mcpServers?.greatping), problem: null };
  } catch {
    return { registered: false, problem: null };
  }
}

export function claudeMcpConfig(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
}

/** Registers (or re-registers) the MCP server with Codex through its own CLI. */
export function registerCodexMcp(launcher: Launcher): string | null {
  const codex = findOnPath('codex');
  if (!codex) return 'The codex command is not on PATH.';
  if (inspectMcp('codex').registered && !unregisterCodexMcp())
    return 'Could not remove the existing GreatPing MCP registration.';
  const result = spawnSync(
    codex,
    ['mcp', 'add', 'greatping', '--', launcher.command, ...launcher.args, 'mcp'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (result.status === 0)
    recordAsset({
      kind: 'mcp',
      path: codexConfig(),
      host: 'codex',
      launcher: { command: launcher.command, args: [...launcher.args, 'mcp'] },
    });
  return result.status === 0
    ? null
    : (result.stderr || result.stdout || 'codex mcp add failed.').trim();
}

export function mcpInvocationOwned(command: string, args: string[], path: string): boolean {
  const recorded = ownedAssets().find(
    (asset) => asset.kind === 'mcp' && asset.path === path,
  )?.launcher;
  return (
    Boolean(
      recorded &&
        recorded.command === command &&
        JSON.stringify(recorded.args) === JSON.stringify(args),
    ) ||
    (/^greatping(?:\.(?:cmd|exe))?$/.test(basename(command)) && args.includes('mcp')) ||
    (args.includes('mcp') && args.some((arg) => /(?:^|[/\\])greatping(?:[/\\]|$)/.test(arg)))
  );
}

export function unregisterCodexMcp(path = codexConfig()): boolean {
  if (!existsSync(path) || !codexMcpServer(readFileSync(path, 'utf8'))) {
    forgetAsset('mcp', path);
    return true;
  }
  const server = codexMcpServer(readFileSync(path, 'utf8'));
  if (!server || !mcpInvocationOwned(server.command, server.args, path)) return false;
  const codex = findOnPath('codex');
  if (!codex) return false;
  const ok =
    spawnSync(codex, ['mcp', 'remove', 'greatping'], {
      stdio: 'ignore',
      timeout: 15000,
      env: { ...process.env, CODEX_HOME: dirname(path) },
    }).status === 0 && !codexMcpServer(readFileSync(path, 'utf8'));
  if (ok) forgetAsset('mcp', path);
  return ok;
}
