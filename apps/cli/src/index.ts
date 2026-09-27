import process from 'node:process';
import { parseArgs } from 'node:util';
import { PROTOCOL_VERSION } from '@greatping/protocol';
import { ApiError } from './api';
import { ask, notify } from './commands/ask';
import { doctor } from './commands/doctor';
import { hooks } from './commands/hooks';
import { login, logout } from './commands/login';
import { pause, resume } from './commands/pause';
import { setup } from './commands/setup';
import { status } from './commands/status';
import { UsageError } from './commands/usage';
import { runHook } from './integrations/runner';
import { startMcp } from './mcp';
import { color, command, muted, print, ui } from './ui';
import { VERSION } from './version';

type Options = Record<string, { type: 'string' | 'boolean'; short?: string }>;

interface Command {
  usage: string;
  summary: string;
  details?: string[];
  options: Options;
  flags?: Array<[flag: string, description: string]>;
  hidden?: boolean;
  run(
    values: Record<string, string | boolean | undefined>,
    positionals: string[],
  ): Promise<number> | number;
}

const serverFlag: Options = { server: { type: 'string' } };

const commands: Record<string, Command> = {
  login: {
    usage: 'greatping login [--name <name>]',
    summary: 'Pair this computer with your GreatPing devices',
    details: ['Shows a QR code and a code to approve in the GreatPing app.'],
    options: { ...serverFlag, name: { type: 'string' } },
    flags: [['--name <name>', 'Name shown in the app (default: this computer’s name)']],
    run: (v) => login({ server: v.server as string, name: v.name as string }),
  },
  logout: {
    usage: 'greatping logout [--yes]',
    summary: 'Unpair this computer',
    options: { ...serverFlag, yes: { type: 'boolean', short: 'y' } },
    flags: [['-y, --yes', 'Skip the confirmation']],
    run: (v) => logout({ server: v.server as string, yes: Boolean(v.yes) }),
  },
  status: {
    usage: 'greatping status [--json]',
    summary: 'Show pairing, devices and agent integrations',
    options: { ...serverFlag, json: { type: 'boolean' } },
    flags: [['--json', 'Print machine-readable status']],
    run: (v) => status({ server: v.server as string, json: Boolean(v.json) }),
  },
  ask: {
    usage: 'greatping ask <question> [--choices a,b] [--timeout 30m] [--json]',
    summary: 'Ask a question and wait for the answer from your devices',
    details: [
      'Prints the answer to stdout, so it works in scripts:',
      `  ${'answer=$(greatping ask "Deploy now?" --choices Yes,No)'}`,
    ],
    options: {
      ...serverFlag,
      choices: { type: 'string', short: 'c' },
      timeout: { type: 'string', short: 't' },
      json: { type: 'boolean' },
    },
    flags: [
      ['-c, --choices <a,b>', 'Offer choices instead of a free-text answer'],
      ['-t, --timeout <time>', 'Give up after 30s, 5m, 1h … (default: 30m)'],
      ['--json', 'Print {"requestId","answer"} as JSON'],
    ],
    run: (v, p) =>
      ask(p.join(' ') || undefined, {
        server: v.server as string,
        choices: v.choices as string,
        timeout: v.timeout as string,
        json: Boolean(v.json),
      }),
  },
  notify: {
    usage: 'greatping notify <message> [--title <title>]',
    summary: 'Send an alert to your devices',
    options: { ...serverFlag, title: { type: 'string' } },
    flags: [['--title <title>', 'Bold first line of the alert']],
    run: (v, p) =>
      notify(p.join(' ') || undefined, { server: v.server as string, title: v.title as string }),
  },
  setup: {
    usage:
      'greatping setup [claude|codex] [--finished|--no-finished] [--no-skill] [--remove] [--yes]',
    summary: 'Set up Claude Code and Codex to alert your devices',
    details: [
      'Claude Code: alerts when it asks a question or needs a permission, and the',
      'alert clears when the prompt closes. Codex: alerts when it finishes a turn,',
      'plus the notify and ask_user tools over MCP. Both get the GreatPing skill,',
      'so you can say "ping me when the deploy is done" or "no pings for an hour".',
      'Alerts are generic; nothing from a prompt leaves this computer.',
    ],
    options: {
      finished: { type: 'boolean' },
      'no-finished': { type: 'boolean' },
      'no-skill': { type: 'boolean' },
      remove: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
    flags: [
      ['--finished', 'Claude Code: also alert when it finishes a turn'],
      ['--no-finished', 'Turn finished-turn alerts off (Codex: removes its alerts)'],
      ['--no-skill', 'Do not install the GreatPing skill'],
      ['--remove', 'Remove everything GreatPing set up for the agents'],
      ['-y, --yes', 'Skip the confirmation (required when not interactive)'],
    ],
    run: (v, p) =>
      setup(p[0], {
        ...(v.finished ? { finished: true } : v['no-finished'] ? { finished: false } : {}),
        skill: !v['no-skill'],
        remove: Boolean(v.remove),
        yes: Boolean(v.yes),
      }),
  },
  pause: {
    usage: 'greatping pause [duration]',
    summary: 'Pause alerts from this computer (default 1h, up to 7d)',
    details: [
      'Requests still appear in the app, but no device is alerted until the pause',
      'ends. Durations look like 30m, 2h or 1d. Devices can pause and resume too.',
    ],
    options: { ...serverFlag },
    run: (v, p) => pause(p[0], { server: v.server as string }),
  },
  resume: {
    usage: 'greatping resume',
    summary: 'Resume alerts from this computer',
    options: { ...serverFlag },
    run: (v) => resume({ server: v.server as string }),
  },
  doctor: {
    usage: 'greatping doctor [--fix]',
    summary: 'Check pairing, alerts and agent integrations',
    details: ['Runs each installed hook once with a test event that sends nothing.'],
    options: { ...serverFlag, fix: { type: 'boolean' } },
    flags: [['--fix', 'Repair hooks and tools that cannot run or are outdated']],
    run: (v) => doctor({ server: v.server as string, fix: Boolean(v.fix) }),
  },
  hooks: {
    usage: 'greatping hooks <install|uninstall|status> [claude|codex] [--finished|--no-finished]',
    summary: 'Install or remove only the agent hooks',
    details: ['Usually you want greatping setup, which also adds the skill and tools.'],
    hidden: true,
    options: { finished: { type: 'boolean' }, 'no-finished': { type: 'boolean' } },
    run: (v, p) =>
      hooks(
        p[0],
        p[1],
        v.finished ? { finished: true } : v['no-finished'] ? { finished: false } : {},
      ),
  },
  mcp: {
    usage: 'greatping mcp',
    summary: 'Serve the ask_user and notify tools over MCP (stdio)',
    options: {},
    run: () => {
      startMcp();
      return new Promise<number>(() => {});
    },
  },
  hook: {
    usage: 'greatping hook <claude|codex> [--finished]',
    summary: 'Internal: handle an agent hook event from stdin',
    hidden: true,
    options: { finished: { type: 'boolean' } },
    run: (v, p) =>
      p[0] === 'claude' || p[0] === 'codex' ? runHook(p[0], { finished: Boolean(v.finished) }) : 0,
  },
};

function printHelp(): void {
  print();
  print(`  ${color.bold('GreatPing')} ${muted(`v${VERSION}`)}`);
  print(`  ${muted('Get an alert on your phone or tablet when your coding agent needs you.')}`);
  print();
  print(`  ${color.bold('Usage')}  ${command('greatping <command> [options]')}`);
  print();
  print(`  ${color.bold('Commands')}`);
  const visible = Object.entries(commands).filter(([, c]) => !c.hidden);
  const width = Math.max(...visible.map(([name]) => name.length));
  for (const [name, c] of visible) print(`    ${command(name.padEnd(width))}  ${c.summary}`);
  print();
  print(`  ${color.bold('Options')}`);
  print(`    ${command('--server <url>')}  Use another GreatPing server (or GREATPING_API_URL)`);
  print(`    ${command('--no-color')}      Plain output (also NO_COLOR=1)`);
  print(`    ${command('-h, --help')}      Help for a command: greatping <command> --help`);
  print(`    ${command('-v, --version')}   Print the version`);
  print();
  print(`  ${muted(`Get started with ${command('greatping login')}.`)}`);
  print();
}

function printCommandHelp(name: string, c: Command): void {
  print();
  print(`  ${color.bold(c.summary)}`);
  print();
  print(`  ${color.bold('Usage')}  ${command(c.usage)}`);
  if (c.details) {
    print();
    for (const line of c.details) print(`  ${muted(line)}`);
  }
  const flags = [...(c.flags ?? [])];
  if ('server' in c.options) flags.push(['--server <url>', 'Use another GreatPing server']);
  if (flags.length) {
    print();
    print(`  ${color.bold('Options')}`);
    const width = Math.max(...flags.map(([flag]) => flag.length));
    for (const [flag, description] of flags)
      print(`    ${command(flag.padEnd(width))}  ${description}`);
  }
  print();
  void name;
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv.filter((arg) => arg !== '--no-color');
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    const topic = name === 'help' ? rest[0] : undefined;
    const target = topic ? commands[topic] : undefined;
    if (topic && target) printCommandHelp(topic, target);
    else printHelp();
    return 0;
  }
  if (name === '-v' || name === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (name === 'version') {
    process.stdout.write(`greatping ${VERSION} (protocol ${PROTOCOL_VERSION})\n`);
    return 0;
  }

  const target = commands[name];
  if (!target) {
    const guess = Object.keys(commands).find((key) => key.startsWith(name.slice(0, 2)));
    ui.error(
      `Unknown command "${name}".`,
      guess
        ? `Did you mean ${command(`greatping ${guess}`)}?`
        : `Run ${command('greatping --help')} to see all commands.`,
    );
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    printCommandHelp(name, target);
    return 0;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: target.options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(
      name,
      error instanceof Error ? error.message.replace(/\. To specify.*$/s, '.') : 'Invalid options.',
    );
  }
  return target.run(
    parsed.values as Record<string, string | boolean | undefined>,
    parsed.positionals,
  );
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      ui.error(error.message, error.hint);
      const usage = error.command ? commands[error.command]?.usage : undefined;
      if (usage) print(`    ${muted('Usage:')} ${command(usage)}`);
    } else if (error instanceof ApiError) {
      ui.error(
        error.message,
        error.status === 401
          ? `Run ${command('greatping logout')} and then ${command('greatping login')} to pair again.`
          : error.status === 0
            ? 'Check your internet connection and try again.'
            : undefined,
      );
    } else {
      ui.error(error instanceof Error ? error.message : String(error));
      if (process.env.GREATPING_DEBUG && error instanceof Error && error.stack)
        print(muted(error.stack));
    }
    process.exitCode = 1;
  });
