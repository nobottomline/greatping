import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
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
  const section = toml.match(/^\s*\[mcp_servers\.greatping\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m);
  if (!section?.[1]) return null;
  const body = section[1];
  const command = body.match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1];
  if (command === undefined) return { command: '', args: [] };
  const list = body.match(/^\s*args\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '';
  const args = [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] ?? '').replace(/\\(["\\])/g, '$1'),
  );
  return { command: command.replace(/\\(["\\])/g, '$1'), args };
}

export function inspectMcp(host: HostId): McpState {
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
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return { registered: Boolean(config.mcpServers?.greatping), problem: null };
  } catch {
    return { registered: false, problem: null };
  }
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
