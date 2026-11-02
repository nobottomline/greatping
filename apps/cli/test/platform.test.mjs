import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseWindowsShellCommand,
  windowsShellCommand,
} from '../../../plugins/shared/windows-command.mjs';

const cli =
  process.env.GREATPING_TEST_CLI ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tests = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  (name === 'pairing-fetch'
    ? process.env.GREATPING_TEST_PAIRING_FIXTURE
    : process.env[`GREATPING_TEST_${name.toUpperCase().replaceAll('-', '_')}_FIXTURE`]) ??
  join(tests, 'fixtures', `${name}.mjs`);
const { pairedConfig } = await import(pathToFileURL(fixture('account')).href);
const service = 'https://api.greatping.com';
const windows = process.platform === 'win32';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const preload = (name) => [
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  pathToFileURL(join(tests, 'ts-resolve.mjs')).href,
  '--import',
  pathToFileURL(fixture(name)).href,
];

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'greatping platform & Привет '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const runtime = join(root, 'runtime');
  mkdirSync(runtime);
  copyFileSync(process.execPath, join(runtime, windows ? 'node.exe' : 'node'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: config,
    CODEX_HOME: join(root, '.codex'),
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CI: '1',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    NODE_OPTIONS: '',
    // Qualification must not inspect or depend on agents installed by the
    // developer. Keep only the runtime and operating-system utilities.
    PATH: [
      runtime,
      ...(windows
        ? [
            join(process.env.SystemRoot, 'System32'),
            join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'),
            join(process.env.ProgramFiles, 'PowerShell', '7'),
          ]
        : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
    ].join(delimiter),
  };
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 20000,
      ...options,
    });
  return { root, env, run, directory: join(config, 'greatping') };
}
function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}
function powershell(script, env) {
  return spawnSync(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { env, encoding: 'utf8', timeout: 20000 },
  );
}
function privateAcl(path, env) {
  const result = powershell(
    `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $env:GREATPING_TEST_ACL_PATH
if ((Get-Item -LiteralPath $env:GREATPING_TEST_ACL_PATH).PSIsContainer -and -not $acl.AreAccessRulesProtected) { throw 'Inheritance remains enabled' }
$rules = @($acl.Access)
if ($rules.Count -ne 1) { throw 'Unexpected access rules' }
if ($rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Foreign principal' }
if ($rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Unexpected rights' }
`,
    { ...env, GREATPING_TEST_ACL_PATH: path },
  );
  success(result);
}

test('Windows hook transport preserves special characters and rejects forged ownership metadata', () => {
  const parts = [
    String.raw`C:\Users\A&B %TEMP%\node.exe`,
    'Привет',
    '',
    '"quoted"',
    "it's",
    'end\\',
    'a\nb',
  ];
  const command = windowsShellCommand(parts);
  assert.deepEqual(parseWindowsShellCommand(command), parts);
  assert.doesNotMatch(command, /[&%|<>\r\n]/);
  const prefix = command.slice(0, command.lastIndexOf(' ') + 1);
  const body = Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
  assert.deepEqual(
    parseWindowsShellCommand(
      prefix + Buffer.from(`${body}\nWrite-Output injected`, 'utf16le').toString('base64'),
    ),
    [],
  );
  assert.equal(parseWindowsShellCommand('greatping hook codex'), null);
  assert.throws(() => windowsShellCommand(['node', '\0']), /Invalid/);
});

test('Windows hook command executes literal argv, stdin and exit code through cmd.exe', {
  skip: !windows,
}, (t) => {
  const h = home(t);
  const bin = join(h.root, "A&B %TEMP% !caret^ it's");
  mkdirSync(bin);
  const node = join(bin, 'node.exe');
  copyFileSync(process.execPath, node);
  const script = join(bin, 'echo argv.mjs');
  writeFileSync(
    script,
    "import {readFileSync} from 'node:fs';console.log(JSON.stringify({args:process.argv.slice(2),stdin:readFileSync(0,'utf8')}));process.exit(7);",
  );
  const args = [
    '',
    'a&b',
    '%TEMP%',
    '!PATH!',
    '^',
    '"quoted"',
    "it's",
    'Привет',
    'trailing\\',
    'a\nb',
  ];
  const result = spawnSync(windowsShellCommand([node, script, ...args]), {
    shell: true,
    env: h.env,
    input: 'hook stdin\n',
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, stdin: 'hook stdin\n' });
});

test('run preserves native argv and child exit codes', (t) => {
  const h = home(t);
  const script = join(h.root, 'echo.mjs');
  writeFileSync(
    script,
    'console.log(JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.GREATPING_TEST_EXIT ?? 0));',
  );
  const args = [
    '',
    'a&b',
    '%TEMP%',
    '!PATH!',
    '"quoted"',
    "it's",
    'Привет',
    'trailing\\',
    'line\nbreak',
  ];
  const result = h.run(['run', '--on-fail', '--', process.execPath, script, ...args]);
  success(result);
  assert.deepEqual(JSON.parse(result.stdout), args);
  const failed = h.run(['run', '--', process.execPath, script], {
    env: { ...h.env, GREATPING_TEST_EXIT: '7' },
  });
  assert.equal(failed.status, 7, failed.stderr);
  assert.match(failed.stderr, /not paired/i);
});

test('Windows run resolves npm-style CMD shims and preserves literal arguments', {
  skip: !windows,
}, (t) => {
  const h = home(t);
  const bin = join(h.root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'fixture.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`,
  );
  writeFileSync(join(bin, 'fixture.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const args = [
    '',
    'hello world',
    'a&b',
    'a|b',
    '%TEMP%',
    '!PATH!',
    '^',
    '"quoted"',
    'Привет',
    'trailing\\',
  ];
  const result = h.run(['run', '--on-fail', '--', 'fixture', ...args], {
    env: { ...h.env, PATH: `${bin};${h.env.PATH}` },
  });
  success(result);
  assert.deepEqual(JSON.parse(result.stdout), args);
  const rejected = h.run(['run', '--', 'fixture', 'safe\r\necho injected']);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.doesNotMatch(rejected.stdout, /injected/);
  const disguised = join(bin, 'not-native.exe');
  writeFileSync(disguised, `#!${process.execPath}\nconsole.log('unexpected script execution');\n`);
  const refused = h.run(['run', '--on-fail', '--', disguised, 'line\nbreak']);
  assert.notEqual(refused.status, 0, 'An EXE must never fall back to a shebang interpreter');
  assert.equal(refused.stdout, '');
});

test('Windows PowerShell 5.1 and PowerShell 7 can invoke the installed npm launcher', {
  skip: !windows,
}, (t) => {
  const h = home(t);
  const launcher = process.env.GREATPING_TEST_LAUNCHER;
  assert.ok(launcher, 'Windows archive runner must provide its real npm launcher');
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(
      shell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& $env:GREATPING_TEST_LAUNCHER --version; exit $LASTEXITCODE',
      ],
      {
        env: { ...h.env, GREATPING_TEST_LAUNCHER: launcher },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    success(result);
    assert.equal(
      result.stdout.trim(),
      JSON.parse(readFileSync(resolve(dirname(cli), '../package.json'))).version,
    );
  }
});

test('pairing persists private credentials and survives a new CLI process', (t) => {
  const h = home(t);
  const result = spawnSync(
    process.execPath,
    [...preload('pairing-fetch'), cli, 'login', '--name', 'Platform fixture'],
    {
      cwd: h.root,
      env: h.env,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  success(result);
  const file = join(h.directory, 'config.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.machineId, 'pty-machine');
  assert.ok(saved.keys.sign && saved.keys.enc);
  success(h.run(['project', 'name', 'Fixture project']));
  if (windows) {
    privateAcl(h.directory, h.env);
    privateAcl(file, h.env);
    privateAcl(join(h.directory, 'alerts.json'), h.env);
  } else {
    assert.equal(statSync(h.directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('paired notify and ask exchange encrypted content with a simulated phone', (t) => {
  const h = home(t);
  mkdirSync(h.directory, { recursive: true });
  writeFileSync(join(h.directory, 'config.json'), JSON.stringify(pairedConfig(service)));
  const before = readFileSync(join(h.directory, 'config.json'), 'utf8');
  for (const args of [
    ['notify', 'Platform fixture', '--json'],
    ['ask', 'Choose', '--choices', 'Yes,No', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [...preload('operations-fetch'), cli, ...args], {
      cwd: h.root,
      env: h.env,
      encoding: 'utf8',
      timeout: 20000,
    });
    success(result);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, args[0] === 'ask' ? 'answered' : 'accepted');
    if (args[0] === 'ask') assert.deepEqual(value.answer, { choice: 'Yes' });
  }
  assert.equal(readFileSync(join(h.directory, 'config.json'), 'utf8'), before);
  if (windows) privateAcl(join(h.directory, 'config.json'), h.env);
});

test('installed Claude and Codex hooks execute with JSON stdin and remain removable', (t) => {
  const h = home(t);
  success(h.run(['--help']));
  const dryRun = h.run(['uninstall', '--dry-run', '--json']);
  success(dryRun);
  assert.ok(JSON.parse(dryRun.stdout));
  assert.equal(existsSync(join(h.directory, 'config.json')), false);
  success(h.run(['setup', 'opencode', '--yes']));
  const inventory = h.run(['status', '--json']);
  assert.equal(inventory.status, 1);
  assert.equal(
    JSON.parse(inventory.stdout).plugins.find((plugin) => plugin.id === 'opencode').status,
    'ready',
  );
  success(h.run(['setup', 'opencode', '--remove', '--yes']));
  const state = join(h.directory, 'hook-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(h.directory, 'config.json'),
    JSON.stringify({ apiUrl: service, machineId: 'test-machine', machineToken: 'test-token' }),
  );
  const saved = readFileSync(join(h.directory, 'config.json'));
  for (const host of ['claude', 'codex']) {
    // Setup stays offline; pairing is installed only for the hook invocation.
    const config = join(h.directory, 'config.json');
    rmSync(config, { force: true });
    success(h.run(['hooks', 'install', host, '--finished']));
    writeFileSync(config, saved);
    writeFileSync(join(state, 'report.seen'), '');
    writeFileSync(join(state, `${host}.seen`), '');
    const settings = join(
      h.root,
      host === 'claude' ? '.claude/settings.json' : '.codex/hooks.json',
    );
    const handler = JSON.parse(readFileSync(settings)).hooks.Stop[0].hooks[0];
    const log = join(h.root, `${host}.jsonl`);
    const env = {
      ...h.env,
      NODE_OPTIONS: `--import=${pathToFileURL(fixture('hook-fetch')).href}`,
      GREATPING_TEST_SERVICE: service,
      GREATPING_TEST_RECORD: log,
    };
    const options = {
      env,
      cwd: h.root,
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'platform-fixture' }),
      encoding: 'utf8',
      timeout: 20000,
    };
    const result = handler.args
      ? spawnSync(handler.command, handler.args, options)
      : spawnSync(handler.command, { ...options, shell: true });
    success(result);
    assert.equal(result.stdout, '');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.every((call) => !call.unexpected));
    assert.equal(calls.filter((call) => call.path === '/v1/requests').length, 1);
    rmSync(config);
    success(h.run(['hooks', 'uninstall', host]));
    assert.deepEqual(JSON.parse(readFileSync(settings)).hooks ?? {}, {});
  }
});

test('generated Codex plugin hooks resolve special-character cache paths outside the shell', (t) => {
  const h = home(t);
  const plugin = join(h.root, "plugin & %TEMP% ! it's");
  cpSync(fileURLToPath(new URL('../../../plugins/codex/greatping', import.meta.url)), plugin, {
    recursive: true,
  });
  success(
    spawnSync(
      process.execPath,
      [
        join(plugin, 'scripts/bridge.mjs'),
        'codex',
        'configure',
        '--command',
        join(h.root, 'runtime', windows ? 'node.exe' : 'node'),
        '--arg',
        cli,
      ],
      {
        cwd: h.root,
        env: h.env,
        encoding: 'utf8',
        timeout: 20000,
      },
    ),
  );
  const state = join(h.directory, 'hook-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(h.directory, 'config.json'),
    JSON.stringify({ apiUrl: service, machineId: 'test-machine', machineToken: 'test-token' }),
  );
  writeFileSync(join(state, 'report.seen'), '');
  writeFileSync(join(state, 'codex.seen'), '');
  const command = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'))).hooks.Stop[0].hooks[0]
    .command;
  const log = join(h.root, 'plugin-requests.jsonl');
  const result = spawnSync(command, {
    shell: true,
    cwd: h.root,
    env: {
      ...h.env,
      PLUGIN_ROOT: plugin,
      NODE_OPTIONS: `--import=${pathToFileURL(fixture('hook-fetch')).href}`,
      GREATPING_TEST_SERVICE: service,
      GREATPING_TEST_RECORD: log,
    },
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'plugin-platform-fixture' }),
    encoding: 'utf8',
    timeout: 20000,
  });
  success(result);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => !call.unexpected));
  assert.equal(calls.filter((call) => call.path === '/v1/requests').length, 1);
});

test('Windows repairs broad legacy credential ACLs and refuses inaccessible ACL tooling', {
  skip: !windows,
}, (t) => {
  const h = home(t);
  mkdirSync(h.directory, { recursive: true });
  const file = join(h.directory, 'config.json');
  writeFileSync(file, JSON.stringify(pairedConfig(service)));
  success(h.run(['project', 'name', 'Initial fixture']));
  const alerts = join(h.directory, 'alerts.json');
  // Add an explicit Everyone rule, not merely inherited permissions.
  for (const path of [file, alerts])
    success(
      powershell(
        `$a=Get-Acl -LiteralPath $env:GREATPING_TEST_ACL_PATH; $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), 'Read', 'Allow'))); Set-Acl -LiteralPath $env:GREATPING_TEST_ACL_PATH -AclObject $a`,
        { ...h.env, GREATPING_TEST_ACL_PATH: path },
      ),
    );
  success(h.run(['project', 'name', 'Migration fixture']));
  // project does not read pairing; startup and every credential read must too.
  const log = join(h.root, 'forbidden-network.jsonl');
  const before = readFileSync(file);
  const denied = h.run(['notify', 'fixture', '--json'], {
    env: {
      ...h.env,
      SystemRoot: join(h.root, 'missing Windows'),
      NODE_OPTIONS: `--import=${pathToFileURL(fixture('operations-fetch')).href}`,
      GREATPING_TEST_LOG: log,
    },
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /secure|permissions|PowerShell/i);
  assert.equal(existsSync(log), false, 'ACL failure must stop before any network call');
  assert.deepEqual(readFileSync(file), before);
  privateAcl(file, h.env);
  privateAcl(alerts, h.env);
});

test('Windows cancellation kills the owned child tree and preserves an unrelated process', {
  skip: !windows,
}, async (t) => {
  const h = home(t);
  const file = join(h.root, 'children.json');
  const interrupt = join(h.root, 'interrupt');
  const script = join(h.root, 'tree.mjs');
  writeFileSync(
    script,
    `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
  );
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  const wrapper = spawn(
    process.execPath,
    [
      '--import',
      join(tests, 'fixtures', 'interrupt-run.mjs'),
      cli,
      'run',
      '--',
      process.execPath,
      script,
    ],
    {
      env: { ...h.env, GREATPING_TEST_INTERRUPT: interrupt },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  wrapper.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((r) => wrapper.once('close', r));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let pids = [];
  t.after(() => {
    wrapper.kill('SIGKILL');
    unrelated.kill('SIGKILL');
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  for (let i = 0; i < 300 && !existsSync(file); i++) await pause(20);
  assert.ok(existsSync(file), stderr);
  pids = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(interrupt, '');
  let timer;
  try {
    assert.equal(
      await Promise.race([
        closed,
        new Promise((r) => {
          timer = setTimeout(() => r('hung'), 10000);
        }),
      ]),
      130,
    );
  } finally {
    clearTimeout(timer);
  }
  for (let i = 0; i < 100 && pids.some(alive); i++) await pause(20);
  assert.equal(pids.some(alive), false);
  assert.equal(alive(unrelated.pid), true);
  assert.doesNotMatch(stderr, /Sending completion|could not send|succeeded|failed/);
});

test('WSL qualification uses a Linux runtime and private Linux configuration', {
  skip: !process.env.GREATPING_TEST_REQUIRE_WSL,
}, (t) => {
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid(), 0, 'Qualify as an ordinary Linux user');
  const kernel = readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  assert.match(kernel, /microsoft/i);
  if (process.env.GREATPING_TEST_WSL_VERSION === '2') assert.match(kernel, /WSL2/i);
  if (process.env.GREATPING_TEST_WSL_VERSION === '1') assert.doesNotMatch(kernel, /WSL2/i);
  assert.ok(!resolve(process.execPath).startsWith('/mnt/'), 'Use Linux Node inside WSL');
  const h = home(t);
  assert.ok(!h.directory.startsWith('/mnt/'), 'Keep credentials on the Linux filesystem');
});
