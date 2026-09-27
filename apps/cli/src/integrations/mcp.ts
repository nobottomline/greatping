import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { findOnPath, type Launcher, launcherProblem } from './launcher';
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

function codexConfig(): string {
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
  if (inspectMcp('codex').registered) {
    spawnSync(codex, ['mcp', 'remove', 'greatping'], { stdio: 'ignore', timeout: 15_000 });
  }
  const result = spawnSync(
    codex,
    ['mcp', 'add', 'greatping', '--', launcher.command, ...launcher.args, 'mcp'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  return result.status === 0
    ? null
    : (result.stderr || result.stdout || 'codex mcp add failed.').trim();
}

export function unregisterCodexMcp(): boolean {
  const codex = findOnPath('codex');
  if (!codex || !inspectMcp('codex').registered) return false;
  return (
    spawnSync(codex, ['mcp', 'remove', 'greatping'], { stdio: 'ignore', timeout: 15_000 })
      .status === 0
  );
}
