import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_API_URL } from '../src/config.ts';
import { claudeSteps, codexSteps } from '../src/integrations/events.ts';
import {
  HOSTS,
  inspectHooks,
  installHooks,
  selectedAlerts,
  uninstallHooks,
} from '../src/integrations/host-hooks.ts';
import { isVersionedPath, parseShellCommand, shellCommand } from '../src/integrations/launcher.ts';
import { codexMcpServer } from '../src/integrations/mcp.ts';
import { runSteps } from '../src/integrations/runner.ts';
import { installSkill, skillInstalled, uninstallSkill } from '../src/integrations/skill.ts';
import {
  findAlert,
  lastHookAt,
  openAlert,
  pruneAlerts,
  sessionAlerts,
  touchHeartbeat,
} from '../src/integrations/state.ts';

const interactive = { finished: false, interactive: true };

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
  const [open] = claudeSteps(question, interactive);
  assert.equal(open.op, 'notify');
  // Only title and body reach the server; the correlation is hashed locally.
  assert.doesNotMatch(`${open.title} ${open.body}`, /secret stack/);
  const [close] = claudeSteps({ ...question, hook_event_name: 'PostToolUse' }, interactive);
  assert.deepEqual(close, { op: 'resolve', correlation: open.correlation });

  const permission = {
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
  };
  const [ask] = claudeSteps(permission, interactive);
  assert.equal(ask.op, 'notify');
  assert.doesNotMatch(`${ask.title} ${ask.body}`, /rm -rf/);
  // The tool result gains an ID the permission request may not have had.
  const [done] = claudeSteps(
    { ...permission, hook_event_name: 'PostToolUseFailure', tool_use_id: 'x' },
    interactive,
  );
  assert.equal(done.correlation, ask.correlation);
  const [denied] = claudeSteps({ ...permission, hook_event_name: 'PermissionDenied' }, interactive);
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
        interactive,
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
      interactive,
    )[0].op,
    'notify',
  );
  assert.deepEqual(
    claudeSteps({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, interactive),
    [],
  );
  assert.deepEqual(claudeSteps({ hook_event_name: 'Stop' }, interactive), []);
});

test('MCP input dialogs alert and clear', () => {
  const [open] = claudeSteps(
    { hook_event_name: 'Notification', session_id: 's', notification_type: 'elicitation_dialog' },
    interactive,
  );
  const [close] = claudeSteps(
    { hook_event_name: 'Notification', session_id: 's', notification_type: 'elicitation_response' },
    interactive,
  );
  assert.equal(open.op, 'notify');
  assert.deepEqual(close, { op: 'resolve', correlation: open.correlation });
  assert.deepEqual(
    claudeSteps(
      { hook_event_name: 'Notification', session_id: 's', notification_type: 'idle_prompt' },
      interactive,
    ),
    [],
  );
});

test('a finished turn clears the session and alerts only when asked and interactive', () => {
  const stop = { hook_event_name: 'Stop', session_id: 's' };
  assert.deepEqual(claudeSteps(stop, interactive), [{ op: 'resolve-session' }]);
  const finished = claudeSteps(stop, { finished: true, interactive: true });
  assert.deepEqual(
    finished.map((step) => step.op),
    ['resolve-session', 'notify'],
  );
  assert.deepEqual(claudeSteps(stop, { finished: true, interactive: false }), [
    { op: 'resolve-session' },
  ]);
  assert.deepEqual(
    claudeSteps({ ...stop, stop_hook_active: true }, { finished: true, interactive: true }),
    [{ op: 'resolve-session' }],
  );
  for (const event of ['UserPromptSubmit', 'SessionEnd']) {
    assert.deepEqual(claudeSteps({ hook_event_name: event, session_id: 's' }, interactive), [
      { op: 'resolve-session' },
    ]);
  }
});

test('Codex alerts at the end of a turn and clears when the user is back', () => {
  const on = { finished: true, interactive: true };
  const steps = codexSteps({ hook_event_name: 'Stop', session_id: 'c' }, on);
  assert.deepEqual(
    steps.map((step) => step.op),
    ['resolve-session', 'notify'],
  );
  assert.match(steps[1].title, /Codex/);
  for (const event of ['UserPromptSubmit', 'SessionStart', 'SessionEnd']) {
    assert.deepEqual(codexSteps({ hook_event_name: event, session_id: 'c' }, on), [
      { op: 'resolve-session' },
    ]);
  }
  assert.deepEqual(codexSteps({ hook_event_name: 'PreToolUse', session_id: 'c' }, on), []);
});

test('alert state is per session, reused on retry and pruned when stale', async () => {
  await withHome((root) => {
    const first = openAlert('claude', 's1', 'a');
    assert.equal(openAlert('claude', 's1', 'a').sourceKey, first.sourceKey);
    openAlert('claude', 's1', 'b');
    openAlert('claude', 's2', 'a');
    assert.equal(sessionAlerts('claude', 's1').length, 2);
    assert.equal(sessionAlerts('codex', 's1').length, 0);
    assert.equal(findAlert('claude', 's2', 'a').sourceKey.startsWith('claude:'), true);

    const legacy = join(root, '.config', 'greatping', 'hook-state', 'abc123');
    writeFileSync(legacy, 'claude:old');
    const old = Date.now() / 1000 - 8 * 24 * 3600;
    utimesSync(first.path, old, old);
    pruneAlerts();
    assert.equal(existsSync(legacy), false);
    assert.equal(findAlert('claude', 's1', 'a'), null);
    assert.notEqual(findAlert('claude', 's1', 'b'), null);

    assert.equal(lastHookAt('codex'), null);
    assert.equal(touchHeartbeat('codex'), null);
    assert.ok(lastHookAt('codex') <= Date.now());
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
    assert.deepEqual(inspectHooks(host), {
      status: 'ok',
      finished: true,
      problem: null,
      invocation: { command: node, args: [script] },
    });

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
  await withHome(async () => {
    const server = await fakeServer((call, calls) => {
      if (call.path === '/v1/requests/resolve') {
        // The first resolve races ahead of its alert; the retry finds it.
        const attempts = calls.filter(
          (c) => c.path === call.path && c.body.sourceKey === call.body.sourceKey,
        ).length;
        return { resolved: attempts > 1 };
      }
      return { id: 'req_1', status: 'pending' };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      assert.ok(url.startsWith(`${DEFAULT_API_URL}/v1/`));
      return originalFetch(url.replace(DEFAULT_API_URL, server.url), options);
    };
    try {
      const config = { apiUrl: DEFAULT_API_URL, machineId: 'm', machineToken: 't' };
      const question = claudeSteps(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'sess',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'q1',
        },
        interactive,
      );
      await runSteps('claude', 'sess', question, config);
      const created = server.calls.find((c) => c.path === '/v1/requests');
      assert.equal(created.body.kind, 'notify');
      assert.equal(typeof created.body.away, 'boolean');
      assert.match(created.body.sourceKey, /^claude:/);
      assert.equal(sessionAlerts('claude', 'sess').length, 1);

      await runSteps('claude', 'sess', [{ op: 'resolve-session' }], config);
      const resolves = server.calls.filter((c) => c.path === '/v1/requests/resolve');
      assert.equal(resolves.length, 2);
      assert.equal(resolves[0].body.sourceKey, created.body.sourceKey);
      assert.equal(sessionAlerts('claude', 'sess').length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});

test('an unpaired computer only forgets local alerts', async () => {
  await withHome(async () => {
    openAlert('codex', 'x', 'finished');
    await runSteps('codex', 'x', [{ op: 'resolve-session' }], { apiUrl: 'http://127.0.0.1:9' });
    assert.equal(sessionAlerts('codex', 'x').length, 0);
  });
});

test('disabled Claude alert types still close previously opened prompts and finished turns', () => {
  const off = { ...interactive, finished: true, alerts: [] };
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
