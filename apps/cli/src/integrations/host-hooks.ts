import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { type HookGroup, type HookHandler, hookGroups, readJson, writeJson } from './json-file';
import {
  isVersionedPath,
  type Launcher,
  launcherProblem,
  parseShellCommand,
  shellCommand,
} from './launcher';
import type { HostId } from './state';

/**
 * GreatPing's hooks in an agent host's settings. The host's own file is the
 * source of truth: GreatPing finds its entries by their `greatping hook <host>`
 * invocation and never touches anything else.
 */

interface HookEvent {
  event: string;
  matcher?: string;
  /**
   * Run in the foreground. Hooks are asynchronous so a slow network never
   * delays the agent, except where the host may exit right after the event
   * and drop a background hook (verified with `codex exec`).
   */
  sync?: boolean;
}

export interface HostHooks {
  id: HostId;
  name: string;
  settingsPath(): string;
  /** Whether the host appears to be set up for this user. */
  detected(): boolean;
  events: HookEvent[];
  handler(launcher: Launcher, hookArgs: string[], sync: boolean): HookHandler;
  /** What the user must do before new hooks run, if anything. */
  activation: string;
}

const CLAUDE_EVENTS: HookEvent[] = [
  // A native question: the AskUserQuestion tool is about to ask.
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  // A permission dialog, unless auto mode decides without the user.
  { event: 'PermissionRequest', matcher: '.*' },
  // An MCP server asks for input in a dialog, and that dialog closing.
  {
    event: 'Notification',
    matcher: 'elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response',
  },
  // The prompt closed: the tool ran, failed or was denied.
  { event: 'PostToolUse', matcher: '.*' },
  { event: 'PostToolUseFailure', matcher: '.*' },
  { event: 'PermissionDenied', matcher: '.*' },
  // The user is back or the turn is over: nothing from before is still waiting.
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'SessionEnd', sync: true },
];

const CODEX_EVENTS: HookEvent[] = [
  { event: 'Stop', sync: true },
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart' },
  { event: 'SessionEnd', sync: true },
];

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export const HOSTS: Record<HostId, HostHooks> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    settingsPath: () => join(homedir(), '.claude', 'settings.json'),
    detected: () => existsSync(join(homedir(), '.claude')),
    events: CLAUDE_EVENTS,
    // Exec form: no shell, so paths with spaces need no quoting. Async: the
    // host never waits for GreatPing, so a slow network cannot delay a prompt.
    handler: (launcher, hookArgs, sync) => ({
      type: 'command',
      command: launcher.command,
      args: [...launcher.args, ...hookArgs],
      ...(sync ? {} : { async: true }),
      timeout: 10,
    }),
    activation: 'New Claude Code sessions use them; review them in /hooks if asked.',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    settingsPath: () => join(codexHome(), 'hooks.json'),
    detected: () => existsSync(codexHome()),
    events: CODEX_EVENTS,
    handler: (launcher, hookArgs, sync) => ({
      type: 'command',
      command: shellCommand([launcher.command, ...launcher.args, ...hookArgs]),
      ...(sync ? {} : { async: true }),
      // Codex clamps SessionEnd hooks to 3 seconds.
      timeout: 10,
    }),
    activation: 'Codex runs new hooks only after you trust them: open Codex and use /hooks.',
  },
};

interface OwnHandler {
  command: string;
  args: string[];
  finished: boolean;
}

/** GreatPing's invocation in a handler, or null for anyone else's handler. */
function ownHandler(host: HostId, handler: unknown): OwnHandler | null {
  if (!handler || typeof handler !== 'object') return null;
  const { command, args } = handler as { command?: unknown; args?: unknown };
  if (typeof command !== 'string') return null;
  const parts = Array.isArray(args)
    ? [command, ...args.filter((arg): arg is string => typeof arg === 'string')]
    : parseShellCommand(command);
  const at = parts.indexOf('hook');
  if (at < 0 || parts[at + 1] !== host) return null;
  const [executable = '', ...rest] = parts;
  return {
    command: executable,
    args: rest.slice(0, at - 1),
    finished: parts.slice(at + 2).includes('--finished'),
  };
}

function isOwnGroup(host: HostId, group: unknown): boolean {
  const handlers = (group as HookGroup | null)?.hooks;
  return Array.isArray(handlers) && handlers.some((handler) => ownHandler(host, handler));
}

export interface HooksState {
  /** off: not installed; ok: complete and runnable; broken: cannot run; outdated: events missing. */
  status: 'off' | 'ok' | 'broken' | 'outdated';
  finished: boolean;
  problem: string | null;
  /** The installed invocation, for a probe run. */
  invocation: { command: string; args: string[] } | null;
}

export function inspectHooks(host: HostHooks): HooksState {
  let groups: Record<string, HookGroup[]>;
  try {
    groups = hookGroups(readJson(host.settingsPath()));
  } catch (error) {
    return {
      status: 'broken',
      finished: false,
      problem: error instanceof Error ? error.message : 'Unreadable settings.',
      invocation: null,
    };
  }
  const found = host.events.map(({ event }) =>
    (Array.isArray(groups[event]) ? groups[event] : [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .map((handler) => ownHandler(host.id, handler))
      .find((own): own is OwnHandler => own !== null),
  );
  const first = found.find((own) => own !== undefined);
  if (!first) return { status: 'off', finished: false, problem: null, invocation: null };
  const problem = launcherProblem(first.command, first.args);
  const invocation = { command: first.command, args: first.args };
  if (problem) return { status: 'broken', finished: first.finished, problem, invocation };
  if (found.some((own) => own === undefined)) {
    return {
      status: 'outdated',
      finished: first.finished,
      problem: 'installed by an older GreatPing',
      invocation,
    };
  }
  // Works today, but stops when that Node version is removed by an update.
  if (isVersionedPath(first.command)) {
    return {
      status: 'outdated',
      finished: first.finished,
      problem: `tied to one Node version (${first.command})`,
      invocation,
    };
  }
  return { status: 'ok', finished: first.finished, problem: null, invocation };
}

/** Installs or repairs the host's hooks; repeatable and preserves other hooks. */
export function installHooks(host: HostHooks, launcher: Launcher, finished: boolean): void {
  const path = host.settingsPath();
  const settings = readJson(path);
  const groups = { ...hookGroups(settings) };
  const hookArgs = ['hook', host.id, ...(finished ? ['--finished'] : [])];
  for (const existing of Object.keys(groups)) {
    const kept = (Array.isArray(groups[existing]) ? groups[existing] : []).filter(
      (group) => !isOwnGroup(host.id, group),
    );
    if (kept.length > 0) groups[existing] = kept;
    else delete groups[existing];
  }
  for (const { event, matcher, sync } of host.events) {
    groups[event] = [
      ...(groups[event] ?? []),
      { ...(matcher ? { matcher } : {}), hooks: [host.handler(launcher, hookArgs, sync === true)] },
    ];
  }
  writeJson(path, { ...settings, hooks: groups });
}

/** Removes only GreatPing's hooks; returns whether anything changed. */
export function uninstallHooks(host: HostHooks): boolean {
  const path = host.settingsPath();
  if (!existsSync(path)) return false;
  const settings = readJson(path);
  const groups = { ...hookGroups(settings) };
  let changed = false;
  for (const event of Object.keys(groups)) {
    const all = Array.isArray(groups[event]) ? groups[event] : [];
    const kept = all.filter((group) => !isOwnGroup(host.id, group));
    if (kept.length === all.length) continue;
    changed = true;
    if (kept.length > 0) groups[event] = kept;
    else delete groups[event];
  }
  if (!changed) return false;
  const { hooks: _removed, ...rest } = settings;
  writeJson(path, Object.keys(groups).length > 0 ? { ...rest, hooks: groups } : rest);
  return true;
}
