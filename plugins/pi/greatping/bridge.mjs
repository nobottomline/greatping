// Canonical plugin launcher. Generated packages carry a byte-identical copy.
// Client state, credentials, transport and host events belong to the CLI.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS = ['claude', 'codex', 'opencode', 'pi', 'cursor'];
const ALERTS = ['questions', 'permissions', 'tool-input'];
const MIN_CLI = '0.4.0';
const MIN_NODE = '22.20.0';
const HOOK_DEADLINE_MS = 8000;

function atLeast(actual, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const parts = actual.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== required[i]) return parts[i] > required[i];
  }
  return true;
}

function settingsPath(host) {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.config'));
  return join(base, 'greatping', 'plugins', `${host}.json`);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    // JSON parser errors can quote private values from a user's host settings.
    throw new Error(
      'A plugin or host settings file is unreadable or invalid. Repair it before continuing.',
    );
  }
}

export function readSettings(host) {
  const value = readJson(settingsPath(host));
  if (!value) return null;
  if (
    value.version !== 1 ||
    typeof value.finished !== 'boolean' ||
    !Array.isArray(value.alerts) ||
    value.alerts.some((item) => !ALERTS.includes(item)) ||
    typeof value.launcher?.command !== 'string' ||
    !isAbsolute(value.launcher.command) ||
    !Array.isArray(value.launcher.args) ||
    value.launcher.args.some((arg) => typeof arg !== 'string')
  )
    throw new Error('Plugin settings are invalid. Run configure again.');
  return value;
}

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir && isAbsolute(dir))
    .flatMap((dir) => extensions.map((ext) => join(dir, `${name}${ext}`)))
    .filter(executable);
}

function versioned(path) {
  return /[/\\]v?\d+\.\d+\.\d+[/\\]|fnm_multishells/.test(path);
}

function defaultLauncher() {
  const cli = onPath('greatping').find((path) => !versioned(path));
  if (!cli) throw new Error('Install GreatPing globally, then run configure in your terminal.');
  // Keep the bin symlink, which survives npm updates; avoid its versioned target.
  if (/\.(?:m|c)?js$/.test(realpathSync(cli))) {
    const node = onPath('node').find((path) => !versioned(path));
    if (!node) throw new Error('Use a stable Node launcher with --command and --arg.');
    return { command: node, args: [cli] };
  }
  if (/\.cmd$/i.test(cli))
    throw new Error(
      'Use --command with node.exe and --arg with the installed CLI JavaScript file.',
    );
  return { command: cli, args: [] };
}

export function childEnvironment(launcher) {
  return {
    ...process.env,
    PATH: [dirname(launcher.command), dirname(process.execPath), process.env.PATH ?? ''].join(
      delimiter,
    ),
    NO_UPDATE_NOTIFIER: '1',
  };
}

function cliVersion(launcher, host) {
  if (!executable(launcher.command)) throw new Error('The saved CLI launcher is missing.');
  const result = spawnSync(launcher.command, [...launcher.args, '--version'], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024,
    env: childEnvironment(launcher),
  });
  const version = result.stdout?.trim().replace(/^v/, '') ?? '';
  if (result.status !== 0 || !atLeast(version, MIN_CLI) || Number(version.split('.')[0]) !== 0)
    throw new Error(`A compatible GreatPing CLI is required (>=${MIN_CLI}, <1.0.0).`);
  if (host === 'opencode' || host === 'pi' || host === 'cursor') {
    const probe = spawnSync(launcher.command, [...launcher.args, 'adapter-capabilities'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024,
      env: childEnvironment(launcher),
    });
    if (probe.status !== 0 || !probe.stdout.trim().split(',').includes(host))
      throw new Error(
        'This CLI does not include native adapters. Install a build with OpenCode/Pi/Cursor support.',
      );
  }
  return version;
}

function hookSettings(host) {
  return host === 'claude'
    ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
    : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
}

// Observe legacy CLI handlers only. Never write host settings or trust decisions.
function invocation(handler) {
  if (typeof handler?.command !== 'string') return [];
  if (Array.isArray(handler.args))
    return handler.args.every((arg) => typeof arg === 'string')
      ? [handler.command, ...handler.args]
      : [];
  const parts = [];
  const pattern = /'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of handler.command.matchAll(pattern))
    parts.push(
      match[1] !== undefined
        ? match[1].replace(/'\\''/g, "'")
        : match[2] !== undefined
          ? match[2].replace(/\\"/g, '"')
          : match[3],
    );
  return parts;
}

function legacyHandlers(host) {
  if (host === 'opencode' || host === 'pi' || host === 'cursor') return [];
  const settings = readJson(hookSettings(host));
  const journal = readJson(join(dirname(dirname(settingsPath(host))), 'installation.json'));
  if (journal && (journal.version !== 1 || !Array.isArray(journal.assets)))
    throw new Error('Installation ownership is invalid. Repair it before migration.');
  return Object.values(settings?.hooks ?? {}).flatMap((groups) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).map(invocation).filter((parts) => {
        const at = parts.indexOf('hook');
        return (
          at > 0 &&
          parts[at + 1] === host &&
          (journal?.assets.some(
            (asset) =>
              asset?.kind === 'hooks' &&
              asset.host === host &&
              asset.path === hookSettings(host) &&
              asset.launcher?.command === parts[0] &&
              Array.isArray(asset.launcher.args) &&
              asset.launcher.args.length === at - 1 &&
              asset.launcher.args.every(
                (arg, index) => typeof arg === 'string' && arg === parts[index + 1],
              ),
          ) ||
            /^greatping(?:\.(?:cmd|exe))?$/.test(basename(parts[0])) ||
            parts
              .slice(1, at)
              .some(
                (part) =>
                  isAbsolute(part) &&
                  /\.(?:m|c)?js$/.test(part) &&
                  /(?:^|[/\\])greatping(?:[/\\]|$)/.test(part),
              ))
        );
      }),
    ),
  );
}

function mcpConflict(host) {
  if (host === 'cursor')
    return Boolean(readJson(join(homedir(), '.cursor', 'mcp.json'))?.mcpServers?.greatping);
  if (host === 'opencode' || host === 'pi') return false;
  if (host === 'claude')
    return Boolean(
      readJson(
        process.env.CLAUDE_CONFIG_DIR
          ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
          : join(homedir(), '.claude.json'),
      )?.mcpServers?.greatping,
    );
  const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  return (
    existsSync(path) &&
    /^\s*\[mcp_servers\.(?:greatping|"greatping"|'greatping')\]\s*(?:#.*)?$/m.test(
      readFileSync(path, 'utf8'),
    )
  );
}

function configure(host, args) {
  let launcher;
  let finished;
  const prefix = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--command' && args[i + 1]) launcher = { command: args[++i], args: prefix };
    else if (arg === '--arg' && args[i + 1]) prefix.push(args[++i]);
    else if (arg === '--finished') finished = true;
    else if (arg === '--no-finished') finished = false;
    else
      throw new Error(
        'Use configure [--command <absolute executable> --arg <argument>] [--finished|--no-finished].',
      );
  }
  if (!launcher && prefix.length) throw new Error('--arg requires --command.');
  launcher ??= defaultLauncher();
  if (!isAbsolute(launcher.command) || versioned(launcher.command))
    throw new Error('Choose an absolute launcher that survives runtime updates.');
  const version = cliVersion(launcher, host);
  // Explicit configuration can repair malformed launcher preferences. Valid
  // choices are retained; credentials and native host settings are separate.
  let previous = null;
  try {
    previous = readSettings(host);
  } catch {
    /* Replace invalid plugin preferences only. */
  }
  const legacy = legacyHandlers(host);
  const enabled = legacy.some((parts) => parts.includes('--finished'));
  const selected = legacy.find((parts) => parts.includes('--alerts'));
  const alerts = selected
    ? (selected[selected.indexOf('--alerts') + 1] ?? '')
        .split(',')
        .filter((item) => ALERTS.includes(item))
    : ALERTS;
  const value = {
    version: 1,
    launcher,
    finished: finished ?? previous?.finished ?? (host !== 'claude' || enabled),
    alerts: previous?.alerts ?? [...alerts],
  };
  const path = settingsPath(host);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  process.stderr.write(
    `GreatPing ${version}: plugin launcher saved. Pairing and host settings are unchanged.\n`,
  );
  if (legacy.length)
    process.stderr.write(
      `CLI hooks remain active; plugin hooks stand by. Migrate with greatping setup ${host} --remove.\n`,
    );
}

function check(host) {
  const settings = readSettings(host);
  if (!settings) throw new Error('Run configure in your terminal before enabling this plugin.');
  const version = cliVersion(settings.launcher, host);
  const health = spawnSync(
    settings.launcher.command,
    [...settings.launcher.args, 'runtime-health'],
    {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024,
      env: childEnvironment(settings.launcher),
    },
  );
  // Legacy CLIs lack this probe. A supported probe must not hide a pairing
  // bound to a different service. No network call or credential is involved.
  if (health.status === 0) {
    let value;
    try {
      value = JSON.parse(health.stdout);
    } catch {
      throw new Error('Cannot verify CLI pairing readiness.');
    }
    if (value.problem === 'environment_mismatch')
      throw new Error(
        'Saved pairing belongs to another environment. Pair this CLI with a phone build for the same service; preserve the existing credentials until migration is ready.',
      );
    if (value.problem === 'unpaired')
      process.stderr.write(
        'Computer is not paired; run greatping login before expecting alerts.\n',
      );
  }
  const conflicts = [];
  if (legacyHandlers(host).length) conflicts.push('CLI hooks (plugin hooks stand by)');
  if (mcpConflict(host)) conflicts.push('a separately registered greatping MCP server');
  const skill =
    host === 'claude'
      ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'greatping')
      : join(homedir(), '.agents', 'skills', 'greatping');
  if ((host === 'claude' || host === 'codex') && existsSync(join(skill, 'SKILL.md')))
    conflicts.push('a separately installed greatping skill');
  if (conflicts.length)
    throw new Error(
      `Existing integration: ${conflicts.join(', ')}. Remove it through its owner; pairing stays intact. See the plugin README.`,
    );
  process.stderr.write(
    `GreatPing ${version}: launcher ready; ${settings.finished ? 'completion alerts on' : 'completion alerts off'}.\n`,
  );
  if (host === 'codex')
    process.stderr.write(
      'Codex hooks also require trust in /hooks. Native questions and permissions are not covered.\n',
    );
}

async function forward(launcher, args, hook) {
  const child = spawn(launcher.command, [...launcher.args, ...args], {
    stdio: hook ? ['inherit', 'ignore', 'ignore'] : 'inherit',
    env: childEnvironment(launcher),
  });
  let escalation;
  const stop = (signal) => {
    child.kill(signal);
    escalation ??= setTimeout(() => child.kill('SIGKILL'), 250);
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const deadline = hook ? setTimeout(terminate, HOOK_DEADLINE_MS) : null;
  const code = await new Promise((done) => {
    child.once('error', () => done(1));
    child.once('exit', (status, signal) => done(status ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  if (deadline) clearTimeout(deadline);
  if (escalation) clearTimeout(escalation);
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  return hook ? 0 : code;
}

export async function main(args) {
  const [host, mode, ...options] = args;
  const hook = mode === 'hook';
  try {
    if (hook && host === 'cursor') process.stdout.write('{"continue":true}\n');
    if (!HOSTS.includes(host)) throw new Error('Choose claude, codex, opencode, pi or cursor.');
    if (!atLeast(process.versions.node, MIN_NODE))
      throw new Error(`Node.js >=${MIN_NODE} is required.`);
    if (mode === 'configure') {
      configure(host, options);
      return 0;
    }
    if (options.length) throw new Error('Unexpected plugin arguments.');
    if (mode === 'check') {
      check(host);
      return 0;
    }
    if (!['hook', 'mcp'].includes(mode)) throw new Error('Choose configure, check, hook or mcp.');
    const settings = readSettings(host);
    if (!settings)
      throw new Error(
        `Run greatping setup ${host} with a plugin-aware CLI, or the plugin configure command in your terminal.`,
      );
    if (hook) {
      if (process.env.GREATPING_DISABLE === '1' || legacyHandlers(host).length) return 0;
      return await forward(
        settings.launcher,
        [
          'hook',
          host,
          ...(settings.finished ? ['--finished'] : []),
          ...(host === 'claude' ? ['--alerts', settings.alerts.join(',')] : []),
        ],
        true,
      );
    }
    if (mcpConflict(host))
      throw new Error(
        'Remove the separately registered greatping MCP server through its installer before enabling plugin MCP.',
      );
    cliVersion(settings.launcher, host);
    return await forward(settings.launcher, ['mcp'], false);
  } catch (error) {
    if (!hook) process.stderr.write(`GreatPing plugin: ${error.message}\n`);
    return hook ? 0 : 1;
  }
}

// Compiled Bun hosts expose a virtual argv entry that exists but cannot be
// realpathed. Importing launcher helpers must never execute its CLI entrypoint.
let entry = false;
try {
  entry = Boolean(
    process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
  );
} catch {
  /* Imported by a native host or an embedded runtime. */
}
if (entry) process.exitCode = await main(process.argv.slice(2));
