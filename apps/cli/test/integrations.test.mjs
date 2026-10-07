import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { api } from '../src/api.ts';
import { DEFAULT_API_URL } from '../src/config.ts';
import {
  cachedProjectLabels,
  projectFields,
  rememberProjectLabels,
  setProjectOverride,
} from '../src/identity.ts';
import { claudeSteps, codexSteps } from '../src/integrations/events.ts';
import {
  HOSTS,
  inspectHooks,
  installHooks,
  selectedAlerts,
  uninstallHooks,
} from '../src/integrations/host-hooks.ts';
import {
  currentLauncher,
  isVersionedPath,
  parseShellCommand,
  shellCommand,
} from '../src/integrations/launcher.ts';
import { codexMcpServer } from '../src/integrations/mcp.ts';
import { runSteps } from '../src/integrations/runner.ts';
import { installSkill, skillInstalled, uninstallSkill } from '../src/integrations/skill.ts';
import {
  claimReport,
  forget,
  lastHookAt,
  markOpen,
  openedAgo,
  pruneAlerts,
  touchHeartbeat,
} from '../src/integrations/state.ts';
import { reportMachine } from '../src/report.ts';
import { openAsPhone, pairedConfig, projectCommand, stranger } from './fixtures/account.mjs';

const defaultOptions = { finished: false };

test('hook launchers skip stable Node binaries below the supported minimum', async () => {
  await withHome(async (root) => {
    const candidates = ['20.20.0', '22.19.0', '22.20.0'].map((version, index) => {
      const directory = join(root, `runtime-${index}`);
      mkdirSync(directory);
      const executable = join(directory, 'node');
      writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
      chmodSync(executable, 0o755);
      return executable;
    });
    const previousPath = process.env.PATH;
    const previousScript = process.argv[1];
    const script = join(root, 'cli.js');
    writeFileSync(script, '');
    process.env.PATH = candidates.map((candidate) => join(candidate, '..')).join(':');
    process.argv[1] = script;
    try {
      assert.deepEqual(currentLauncher(), { command: candidates[2], args: [realpathSync(script)] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      process.argv[1] = previousScript;
    }
  });
});

/** A stand-in for a Node binary at a version-independent path. */
function fakeNode(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const node = join(bin, 'node');
  writeFileSync(node, '#!/bin/sh\nexit 0\n');
  chmodSync(node, 0o755);
  return node;
}

async function withHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-int-'));
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, '.config');
  process.env.CODEX_HOME = join(root, '.codex');
  try {
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('Claude question and permission alerts are generic and close with their prompt', () => {
  const question = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'AskUserQuestion',
    tool_use_id: 't1',
    tool_input: { questions: [{ question: 'Which secret stack?' }] },
  };
  const [open] = claudeSteps(question, defaultOptions);
  // A step says why the host waits, never what about; the correlation is hashed before sending.
  assert.deepEqual(Object.keys(open).sort(), ['correlation', 'op', 'reason']);
  assert.equal(open.reason, 'question');
  const [close] = claudeSteps({ ...question, hook_event_name: 'PostToolUse' }, defaultOptions);
  assert.deepEqual(close, { op: 'resolve', correlation: open.correlation });

  const permission = {
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
  };
  const [ask] = claudeSteps(permission, defaultOptions);
  assert.equal(ask.op, 'notify');
  assert.equal(ask.reason, 'permission');
  // The tool result gains an ID the permission request may not have had.
  const [done] = claudeSteps(
    { ...permission, hook_event_name: 'PostToolUseFailure', tool_use_id: 'x' },
    defaultOptions,
  );
  assert.equal(done.correlation, ask.correlation);
  const [denied] = claudeSteps(
    { ...permission, hook_event_name: 'PermissionDenied' },
    defaultOptions,
  );
  assert.equal(denied.correlation, ask.correlation);
});

test('auto mode decisions and unrelated tools do not alert', () => {
  for (const auto_response of ['allow', 'deny']) {
    assert.deepEqual(
      claudeSteps(
        {
          hook_event_name: 'PermissionRequest',
          session_id: 's',
          tool_name: 'Bash',
          tool_input: {},
          permission_context: { auto_response },
        },
        defaultOptions,
      ),
      [],
    );
  }
  assert.equal(
    claudeSteps(
      {
        hook_event_name: 'PermissionRequest',
        session_id: 's',
        tool_name: 'Bash',
        tool_input: {},
        permission_context: { auto_response: 'defer' },
      },
      defaultOptions,
    )[0].op,
    'notify',
  );
  assert.deepEqual(
    claudeSteps(
      { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' },
      defaultOptions,
    ),
    [],
  );
  assert.deepEqual(claudeSteps({ hook_event_name: 'Stop' }, defaultOptions), []);
});

test('MCP input dialogs alert and clear', () => {
  const [open] = claudeSteps(
    { hook_event_name: 'Notification', session_id: 's', notification_type: 'elicitation_dialog' },
    defaultOptions,
  );
  const [close] = claudeSteps(
    { hook_event_name: 'Notification', session_id: 's', notification_type: 'elicitation_response' },
    defaultOptions,
  );
  assert.equal(open.op, 'notify');
  assert.deepEqual(close, { op: 'resolve', correlation: open.correlation });
  assert.deepEqual(
    claudeSteps(
      { hook_event_name: 'Notification', session_id: 's', notification_type: 'idle_prompt' },
      defaultOptions,
    ),
    [],
  );
});

test('a finished turn clears the session and alerts only with explicit opt-in', () => {
  const stop = { hook_event_name: 'Stop', session_id: 's' };
  assert.deepEqual(claudeSteps(stop, defaultOptions), [{ op: 'resolve-session' }]);
  const finished = claudeSteps(stop, { finished: true });
  assert.deepEqual(
    finished.map((step) => step.op),
    ['resolve-session', 'notify'],
  );
  assert.deepEqual(claudeSteps({ ...stop, stop_hook_active: true }, { finished: true }), [
    { op: 'resolve-session' },
  ]);
  for (const event of ['UserPromptSubmit', 'SessionEnd']) {
    assert.deepEqual(claudeSteps({ hook_event_name: event, session_id: 's' }, defaultOptions), [
      { op: 'resolve-session' },
    ]);
  }
});

test('Codex alerts at the end of a turn and clears when the user is back', () => {
  const on = { finished: true };
  const steps = codexSteps({ hook_event_name: 'Stop', session_id: 'c' }, on);
  assert.deepEqual(
    steps.map((step) => step.op),
    ['resolve-session', 'notify'],
  );
  assert.equal(steps[1].reason, 'finished');
  for (const event of ['UserPromptSubmit', 'SessionStart', 'SessionEnd']) {
    assert.deepEqual(codexSteps({ hook_event_name: event, session_id: 'c' }, on), [
      { op: 'resolve-session' },
    ]);
  }
  assert.deepEqual(codexSteps({ hook_event_name: 'PreToolUse', session_id: 'c' }, on), []);
});

test('alert marks are per thread, one prompt open at a time, and pruned when stale', async () => {
  await withHome((root) => {
    markOpen('claude', 'thread-a', 'prompt-1');
    assert.ok(openedAgo('claude', 'thread-a', 'prompt-1') < 1000);
    // The server keeps one open alert per thread; so do the marks.
    markOpen('claude', 'thread-a', 'prompt-2');
    assert.equal(openedAgo('claude', 'thread-a', 'prompt-1'), null);
    assert.notEqual(openedAgo('claude', 'thread-a'), null);
    markOpen('claude', 'thread-b', 'prompt-1');
    assert.equal(openedAgo('codex', 'thread-a'), null);
    forget('claude', 'thread-a');
    assert.equal(openedAgo('claude', 'thread-a'), null);
    assert.notEqual(openedAgo('claude', 'thread-b', 'prompt-1'), null);

    const legacy = join(root, '.config', 'greatping', 'hook-state', 'abc123');
    writeFileSync(legacy, 'claude:old');
    const mark = join(root, '.config', 'greatping', 'hook-state', 'claude', 'thread-b', 'prompt-1');
    const old = Date.now() / 1000 - 8 * 24 * 3600;
    utimesSync(mark, old, old);
    pruneAlerts();
    assert.equal(existsSync(legacy), false);
    assert.equal(openedAgo('claude', 'thread-b'), null);

    assert.equal(lastHookAt('codex'), null);
    assert.equal(touchHeartbeat('codex'), null);
    assert.ok(lastHookAt('codex') <= Date.now());
  });
});

test('project labels follow the computer mode and per-project overrides', async () => {
  await withHome((root) => {
    const repo = join(root, 'acme-acquisition-2026');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    const inside = join(repo, 'packages', 'api');
    // Hidden until the user turns labels on.
    assert.deepEqual(projectFields(inside), {});
    rememberProjectLabels('folder');
    const shown = projectFields(inside);
    assert.equal(shown.projectLabel, 'acme-acquisition-2026');
    assert.match(shown.projectKey, /^[A-Za-z0-9_-]{22}$/);
    assert.doesNotMatch(JSON.stringify(shown), /packages|Users|\//);
    // The same project from another directory has the same key.
    assert.equal(projectFields(repo).projectKey, shown.projectKey);

    setProjectOverride(repo, { name: 'Client A' });
    assert.equal(projectFields(inside).projectLabel, 'Client A');
    setProjectOverride(repo, { hidden: true });
    assert.deepEqual(projectFields(inside), {});
    setProjectOverride(repo, null);
    rememberProjectLabels('hidden');
    assert.deepEqual(projectFields(inside), {});
    assert.deepEqual(projectFields(join(root, 'missing')), {});
  });
});

test('Claude hooks install idempotently, keep other hooks and report their state', async () => {
  await withHome((root) => {
    const host = HOSTS.claude;
    mkdirSync(join(root, '.claude'));
    const path = host.settingsPath();
    const own = { matcher: '.*', hooks: [{ type: 'command', command: 'lint-on-save' }] };
    writeFileSync(path, JSON.stringify({ model: 'opus', hooks: { PostToolUse: [own] } }));
    assert.equal(inspectHooks(host).status, 'off');

    const script = join(root, 'greatping.js');
    writeFileSync(script, '');
    const node = fakeNode(root);
    const launcher = { command: node, args: [script] };
    installHooks(host, launcher, false);
    installHooks(host, launcher, true);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.model, 'opus');
    assert.equal(settings.hooks.PostToolUse.length, 2);
    assert.deepEqual(settings.hooks.PostToolUse[0], own);
    const handler = settings.hooks.PermissionRequest[0].hooks[0];
    assert.deepEqual(handler.args, [script, 'hook', 'claude', '--finished']);
    assert.equal(handler.async, true);
    assert.equal(settings.hooks.Stop[0].hooks[0].async, undefined);
    assert.equal(settings.hooks.SessionEnd[0].hooks[0].async, undefined);
    assert.deepEqual(inspectHooks(host), {
      status: 'ok',
      finished: true,
      problem: null,
      invocation: { command: node, args: [script] },
    });

    // An async Stop can be killed when a single-turn SDK process exits.
    settings.hooks.Stop[0].hooks[0].async = true;
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(inspectHooks(host).status, 'outdated');
    installHooks(host, launcher, true);
    assert.equal(inspectHooks(host).status, 'ok');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop[0].hooks[0].async, undefined);

    // A hook set from an older GreatPing is missing newer events.
    delete settings.hooks.Stop;
    writeFileSync(path, JSON.stringify(settings));
    assert.equal(inspectHooks(host).status, 'outdated');

    rmSync(script);
    assert.equal(inspectHooks(host).status, 'broken');

    assert.equal(uninstallHooks(host), true);
    assert.equal(uninstallHooks(host), false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      model: 'opus',
      hooks: { PostToolUse: [own] },
    });
  });
});

test('hooks installed by the previous CLI are recognised and replaced', async () => {
  await withHome((root) => {
    mkdirSync(join(root, '.claude'));
    const path = HOSTS.claude.settingsPath();
    const legacy = {
      type: 'command',
      command: process.execPath,
      args: ['/old/greatping/dist/index.js', 'hook', 'claude'],
      timeout: 5,
    };
    writeFileSync(
      path,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [legacy] }] } }),
    );
    assert.equal(inspectHooks(HOSTS.claude).status, 'broken');
    const script = join(root, 'cli.js');
    writeFileSync(script, '');
    installHooks(HOSTS.claude, { command: process.execPath, args: [script] }, false);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].args[0], script);
  });
});

test('Codex hooks are written as a shell command and read back', async () => {
  await withHome((root) => {
    const host = HOSTS.codex;
    const script = join(root, 'dir with space', "it's.js");
    mkdirSync(join(root, 'dir with space'));
    writeFileSync(script, '');
    const node = fakeNode(root);
    installHooks(host, { command: node, args: [script] }, true);
    const settings = JSON.parse(readFileSync(host.settingsPath(), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), [
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    const handler = settings.hooks.Stop[0].hooks[0];
    assert.equal(handler.args, undefined);
    // `codex exec` exits right after Stop and would drop a background hook.
    assert.equal(handler.async, undefined);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].async, true);
    assert.deepEqual(parseShellCommand(handler.command), [
      node,
      script,
      'hook',
      'codex',
      '--finished',
    ]);
    assert.equal(inspectHooks(host).status, 'ok');
    assert.equal(uninstallHooks(host), true);
    assert.deepEqual(JSON.parse(readFileSync(host.settingsPath(), 'utf8')), {});
  });
});

test('paths tied to one Node version are recognised', () => {
  assert.equal(isVersionedPath('/Users/me/.nvm/versions/node/v22.1.0/bin/node'), true);
  assert.equal(
    isVersionedPath('/Users/me/.local/share/vite-plus/js_runtime/node/24.21.0/bin/node'),
    true,
  );
  assert.equal(isVersionedPath('/Users/me/.local/state/fnm_multishells/1234_567/bin/node'), true);
  assert.equal(isVersionedPath('/opt/homebrew/bin/node'), false);
  assert.equal(isVersionedPath('/Users/me/.volta/bin/node'), false);
});

test('shell quoting round-trips awkward paths', () => {
  const parts = ['/usr/bin/node', '/a b/it\'s "here".js', 'hook', 'codex'];
  assert.deepEqual(parseShellCommand(shellCommand(parts)), parts);
});

test('reads the GreatPing server from Codex config', () => {
  const toml = [
    '[mcp_servers.playwright]',
    'command = "npx"',
    '',
    '[mcp_servers.greatping]',
    'command = "/usr/local/bin/node"',
    'args = ["/path/to/cli.js", "mcp"]',
    '',
    '[plugins."x"]',
    'enabled = true',
  ].join('\n');
  assert.deepEqual(codexMcpServer(toml), {
    command: '/usr/local/bin/node',
    args: ['/path/to/cli.js', 'mcp'],
  });
  assert.equal(codexMcpServer('[mcp_servers.other]\ncommand = "x"\n'), null);
});

test('the skill installs for each host and removes only itself', async () => {
  await withHome((root) => {
    installSkill('claude', '---\nname: greatping\ndescription: test\n---\n');
    installSkill('codex', '---\nname: greatping\ndescription: test\n---\n');
    assert.equal(skillInstalled('claude'), true);
    assert.ok(existsSync(join(root, '.agents', 'skills', 'greatping', 'SKILL.md')));
    assert.equal(uninstallSkill('claude'), true);
    assert.equal(skillInstalled('claude'), false);

    const foreign = join(root, '.claude', 'skills', 'greatping');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: something-else\n---\n');
    assert.equal(uninstallSkill('claude'), false);
    assert.ok(existsSync(foreign));
  });
});

test('the bundled skill is valid for skill installers', async () => {
  const { bundledSkill } = await import('../src/integrations/skill.ts');
  const skill = bundledSkill();
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  assert.match(frontmatter, /^name: greatping$/m);
  const description = frontmatter.match(/^description: (.+)$/m)?.[1] ?? '';
  assert.ok(description.length > 50 && description.length <= 1024);
});

async function fakeServer(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const call = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null };
      // The computer follows the account manifest before sealing; nothing new here.
      if (call.path.startsWith('/v1/manifests')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ manifests: [] }));
        return;
      }
      calls.push(call);
      const reply = handler(call, calls);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('hook steps open, retry and resolve alerts on the server', async () => {
  await withHome(async (root) => {
    const server = await fakeServer((call, calls) => {
      if (call.path === '/v1/requests/resolve') {
        // The first resolve races ahead of its alert; the retry finds it.
        const attempts = calls.filter(
          (c) => c.path === call.path && c.body.thread === call.body.thread,
        ).length;
        return { resolved: attempts > 1 ? 1 : 0 };
      }
      return { id: 'req_1', status: 'pending' };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      assert.ok(url.startsWith(`${DEFAULT_API_URL}/v1/`));
      return originalFetch(url.replace(DEFAULT_API_URL, server.url), options);
    };
    try {
      const config = pairedConfig(DEFAULT_API_URL);
      const project = join(root, 'billing-api');
      mkdirSync(join(project, '.git'), { recursive: true });
      rememberProjectLabels('folder');
      const question = claudeSteps(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-uuid',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'toolu_secret',
        },
        defaultOptions,
      );
      await runSteps('claude', 'sess-uuid', question, config, project);
      const created = server.calls.find((c) => c.path === '/v1/requests');
      assert.equal(created.body.kind, 'attention');
      assert.equal(created.body.host, 'claude-code');
      assert.equal(created.body.reason, 'question');
      assert.match(created.body.thread, /^[A-Za-z0-9_-]{22}$/);
      assert.match(created.body.correlation, /^[A-Za-z0-9_-]{22}$/);
      // The label is the alert's only content, and only the account's devices read it.
      assert.deepEqual(openAsPhone(created.body.envelope), { projectLabel: 'billing-api' });
      assert.doesNotMatch(JSON.stringify(created.body), /billing-api/);
      assert.equal(typeof created.body.away, 'boolean');
      // Raw session and tool ids and paths stay on the computer.
      assert.doesNotMatch(JSON.stringify(created.body), /sess-uuid|toolu_secret|\//);

      await runSteps('claude', 'sess-uuid', [{ op: 'resolve-session' }], config, project);
      const resolves = server.calls.filter((c) => c.path === '/v1/requests/resolve');
      assert.equal(resolves.length, 2);
      assert.deepEqual(resolves[0].body, { host: 'claude-code', thread: created.body.thread });
      assert.equal(openedAgo('claude', created.body.thread), null);

      // Nothing open here: closing events cost no request.
      await runSteps('claude', 'sess-uuid', [{ op: 'resolve-session' }], config, project);
      await runSteps('claude', 'sess-uuid', [{ op: 'resolve', correlation: 'x' }], config);
      assert.equal(server.calls.filter((c) => c.path === '/v1/requests/resolve').length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});

test('an unpaired computer only forgets local alerts', async () => {
  await withHome(async () => {
    const steps = codexSteps({ hook_event_name: 'Stop', session_id: 'x' }, { finished: true });
    const offline = { apiUrl: 'http://127.0.0.1:9' };
    await runSteps('codex', 'x', steps, offline);
    await runSteps('codex', 'x', [{ op: 'resolve-session' }], offline);
  });
});

test('disabled Claude alert types still close previously opened prompts and finished turns', () => {
  const off = { ...defaultOptions, finished: true, alerts: [] };
  for (const input of [
    { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    { hook_event_name: 'Notification', notification_type: 'elicitation_dialog' },
  ])
    assert.deepEqual(claudeSteps({ session_id: 's', ...input }, off), []);
  assert.equal(
    claudeSteps(
      {
        session_id: 's',
        hook_event_name: 'Notification',
        notification_type: 'elicitation_response',
      },
      off,
    )[0].op,
    'resolve',
  );
  assert.equal(
    claudeSteps({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash' }, off)[0].op,
    'resolve',
  );
  assert.deepEqual(
    claudeSteps({ session_id: 's', hook_event_name: 'Stop' }, off).map((step) => step.op),
    ['resolve-session', 'notify'],
  );
});

test('repair preserves a subset of Claude alerts and all cleanup hooks', async () => {
  await withHome((root) => {
    const host = HOSTS.claude;
    const script = join(root, 'greatping.js');
    writeFileSync(script, '');
    const launcher = { command: fakeNode(root), args: [script] };
    installHooks(host, launcher, true, ['permissions']);
    let settings = JSON.parse(readFileSync(host.settingsPath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse, undefined);
    assert.ok(settings.hooks.PermissionRequest);
    assert.ok(settings.hooks.Notification, 'Keep notification responses for cleanup');
    assert.deepEqual(selectedAlerts(host), ['permissions']);
    assert.equal(inspectHooks(host).status, 'ok');
    delete settings.hooks.UserPromptSubmit;
    writeFileSync(host.settingsPath(), JSON.stringify(settings));
    assert.equal(inspectHooks(host).status, 'outdated');
    installHooks(host, launcher, true);
    assert.deepEqual(selectedAlerts(host), ['permissions']);
    assert.equal(inspectHooks(host).status, 'ok');
    settings = JSON.parse(readFileSync(host.settingsPath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse, undefined);
    installHooks(host, launcher, true, []);
    assert.deepEqual(selectedAlerts(host), []);
    assert.equal(inspectHooks(host).status, 'ok');
    assert.ok(JSON.parse(readFileSync(host.settingsPath(), 'utf8')).hooks.Stop);
  });
});

test('install and uninstall preserve foreign handlers sharing a GreatPing hook group', async () => {
  await withHome((root) => {
    const host = HOSTS.claude;
    const script = join(root, 'greatping.js');
    writeFileSync(script, '');
    const launcher = { command: fakeNode(root), args: [script] };
    installHooks(host, launcher, false);
    const settings = JSON.parse(readFileSync(host.settingsPath(), 'utf8'));
    const foreign = { type: 'command', command: 'lint-on-save' };
    settings.hooks.PostToolUse[0].hooks.push(foreign);
    writeFileSync(host.settingsPath(), JSON.stringify(settings));
    installHooks(host, launcher, true, ['questions']);
    uninstallHooks(host);
    assert.deepEqual(JSON.parse(readFileSync(host.settingsPath(), 'utf8')).hooks, {
      PostToolUse: [{ matcher: '.*', hooks: [foreign] }],
    });
  });
});

test('greatping test reports each device once Apple or Google answer', async () => {
  const { describeDevice } = await import('../src/commands/test.ts');
  const { execFile } = await import('node:child_process');
  const device = (fields) => ({
    deviceId: 'd',
    name: 'iPhone',
    platform: 'ios',
    mode: 'first',
    ...fields,
  });
  await withHome(async (root) => {
    const server = await fakeServer((call) =>
      call.method === 'POST'
        ? { id: 'pt_1', createdAt: 1, pending: true, devices: [device({ status: 'sending' })] }
        : { id: 'pt_1', createdAt: 1, pending: false, devices: [device({ status: 'accepted' })] },
    );
    try {
      mkdirSync(join(root, '.config', 'greatping'), { recursive: true });
      writeFileSync(
        join(root, '.config', 'greatping', 'config.json'),
        JSON.stringify({ apiUrl: DEFAULT_API_URL, machineId: 'm', machineToken: 't' }),
      );
      // The real command in its own process, its service URL sent to the fake server.
      const redirect = join(root, 'redirect.mjs');
      writeFileSync(
        redirect,
        `const f = globalThis.fetch; globalThis.fetch = (u, o) => f(String(u).replace(${JSON.stringify(DEFAULT_API_URL)}, ${JSON.stringify(server.url)}), o);`,
      );
      const cli = new URL('../dist/index.js', import.meta.url).pathname;
      const { stdout } = await new Promise((resolve, reject) =>
        execFile(
          process.execPath,
          ['--import', redirect, cli, 'test', '--json'],
          { env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, '.config') } },
          (error, out, err) => (error ? reject(error) : resolve({ stdout: out, stderr: err })),
        ),
      );
      assert.equal(JSON.parse(stdout).devices[0].status, 'accepted');
      assert.deepEqual(
        server.calls.map((c) => [c.method, c.path]),
        [
          ['POST', '/v1/machine/me/test'],
          ['GET', '/v1/push-tests/pt_1'],
        ],
      );
    } finally {
      await server.close();
    }
  });
  assert.match(describeDevice(device({ status: 'accepted' })).line, /accepted by Apple/);
  const refused = describeDevice(
    device({
      platform: 'android',
      status: 'failed',
      reason: 'credentials',
      detail: 'InvalidCredentials',
    }),
  );
  assert.match(refused.line, /refused.*InvalidCredentials/);
  assert.match(refused.hint, /Google refused GreatPing’s push credentials/);
  assert.match(
    describeDevice(device({ status: 'skipped', reason: 'off', mode: 'off' })).line,
    /Off for this computer/,
  );
  assert.match(
    describeDevice(device({ status: 'skipped', reason: 'no_token' })).hint,
    /allow notifications/,
  );
});

test('greatping run alerts once with the outcome, never the arguments, and keeps the exit code', async () => {
  const { commandLabel, durationText } = await import('../src/commands/run.ts');
  const { execFile } = await import('node:child_process');
  assert.equal(commandLabel(['/usr/local/bin/pnpm', 'test', '--filter', 'secret']), 'pnpm test');
  assert.equal(commandLabel(['node', '-e', 'process.exit(1)']), 'node');
  assert.equal(commandLabel(['./deploy.sh', '--token=abc']), 'deploy.sh');
  assert.equal(durationText(45_000), '45s');
  assert.equal(durationText(252_000), '4m 12s');
  assert.equal(durationText(3_780_000), '1h 3m');

  await withHome(async (root) => {
    const server = await fakeServer(() => ({ id: 'req_1', status: 'pending' }));
    const redirect = join(root, 'redirect.mjs');
    writeFileSync(
      redirect,
      `const f = globalThis.fetch; globalThis.fetch = (u, o) => f(String(u).replace(${JSON.stringify(DEFAULT_API_URL)}, ${JSON.stringify(server.url)}), o);`,
    );
    const cli = new URL('../dist/index.js', import.meta.url).pathname;
    const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, '.config') };
    const greatping = (...args) =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          ['--import', redirect, cli, ...args],
          { env },
          (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
        ),
      );
    try {
      // Unpaired: the command still runs and keeps its code; the alert is only a warning.
      const unpaired = await greatping('run', '--', process.execPath, '-e', 'process.exit(4)');
      assert.equal(unpaired.code, 4);
      assert.match(unpaired.stderr, /could not send the alert/);

      mkdirSync(join(root, '.config', 'greatping'), { recursive: true });
      writeFileSync(
        join(root, '.config', 'greatping', 'config.json'),
        JSON.stringify(pairedConfig(DEFAULT_API_URL)),
      );
      const failed = await greatping('run', '--', process.execPath, '-e', 'process.exit(3)');
      assert.equal(failed.code, 3);
      const alert = server.calls.at(-1).body;
      assert.equal(alert.kind, 'notify');
      assert.equal(alert.host, 'cli');
      const content = openAsPhone(alert.envelope);
      assert.equal(content.title, 'node failed');
      assert.match(content.body, /^Exit code 3 after \d+s\.$/);
      assert.doesNotMatch(JSON.stringify(alert), /process\.exit/);

      const quiet = server.calls.length;
      const fine = await greatping('run', '--on-fail', '--', process.execPath, '-e', '');
      assert.equal(fine.code, 0);
      assert.equal(server.calls.length, quiet);

      // Flags after -- belong to the command, not to GreatPing.
      const help = await greatping('run', '--title', 'Node help', '--', process.execPath, '--help');
      assert.equal(help.code, 0);
      assert.match(help.stdout, /Usage: node/);
      const helpContent = openAsPhone(server.calls.at(-1).body.envelope);
      assert.equal(helpContent.title, 'Node help succeeded');
      assert.equal(helpContent.body.startsWith('Finished in '), true);

      const missing = await greatping('run', '--', 'definitely-not-a-command-xyz');
      assert.equal(missing.code, 127);
    } finally {
      await server.close();
    }
  });
});

test('the hourly report keeps its own clock while hooks run every few minutes', async () => {
  await withHome(() => {
    const hour = 3600_000;
    const t0 = 1_790_000_000_000;
    assert.equal(claimReport(hour, t0), true, 'the first run reports');
    // A busy session: hooks every five minutes for two hours.
    const reports = [];
    for (let t = t0 + 300_000; t <= t0 + 2 * hour; t += 300_000) {
      touchHeartbeat('claude', t);
      if (claimReport(hour, t)) reports.push(t);
    }
    assert.deepEqual(reports, [t0 + hour, t0 + 2 * hour]);
    // Ending a session prunes alert state but keeps the report clock.
    pruneAlerts(t0 + 2 * hour);
    assert.equal(claimReport(hour, t0 + 2 * hour + 60_000), false);
  });
});

test('every service answer carrying the project-label mode updates the cached mode', async () => {
  await withHome(async () => {
    const originalFetch = globalThis.fetch;
    let mode = 'folder';
    globalThis.fetch = async () =>
      new Response('{}', { status: 201, headers: { 'x-greatping-project-labels': mode } });
    try {
      assert.equal(cachedProjectLabels(), 'hidden');
      const config = { apiUrl: DEFAULT_API_URL, machineId: 'mch_1', machineToken: 'mc_x' };
      await api(config, 'POST', '/requests', { body: {} });
      assert.equal(cachedProjectLabels(), 'folder');
      mode = 'hidden';
      await api(config, 'POST', '/requests', { body: {} });
      assert.equal(cachedProjectLabels(), 'hidden');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('the computer lists its projects sealed and applies renames a device signed', async () => {
  await withHome(async (root) => {
    const project = join(root, 'acme-acquisition-2026');
    mkdirSync(join(project, '.git'), { recursive: true });
    rememberProjectLabels('folder');
    const { projectKey } = projectFields(project);
    const server = await fakeServer((call) => {
      if (call.path === '/v1/machine/me/project-commands/take')
        return {
          commands: [
            // A forged command first: ignored, the real one still applies.
            projectCommand(projectKey, { hidden: true }, stranger),
            projectCommand(projectKey, { name: 'Client A' }),
          ],
        };
      if (call.method === 'GET') return { machine: { projectLabels: 'folder' } };
      return {};
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) =>
      originalFetch(String(url).replace(DEFAULT_API_URL, server.url), options);
    try {
      await reportMachine(pairedConfig(DEFAULT_API_URL));
      const report = server.calls.find((c) => c.method === 'PATCH');
      assert.doesNotMatch(JSON.stringify(report.body), /acme/);
      assert.deepEqual(openAsPhone(report.body.projectsEnvelope, 'projects'), {
        projects: [{ key: projectKey, label: 'acme-acquisition-2026' }],
      });
      // The device's rename now names the project's alerts; the forgery did not hide it.
      assert.deepEqual(projectFields(project), { projectKey, projectLabel: 'Client A' });
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});
