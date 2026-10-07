#!/usr/bin/env node
// Actual installed hosts, disposable homes, a loopback model and a recorded
// fixture transport. No real model account, GreatPing service or phone delivery.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'greatping native qualification '));
const cli = process.env.GREATPING_TEST_CLI || join(root, 'apps/cli/dist/index.js');
const home = join(temporary, 'home');
const config = join(temporary, 'config');
const bin = join(temporary, 'bin');
const record = join(temporary, 'requests.ndjson');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: config,
  XDG_CACHE_HOME: join(temporary, 'cache'),
  XDG_DATA_HOME: join(temporary, 'data'),
  PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
  OPENCODE_CONFIG_DIR: join(config, 'opencode'),
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  NO_COLOR: '1',
  CI: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_ENABLE_QUESTION_TOOL: '1',
  OPENCODE_CLIENT: 'cli',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_SHARE: '1',
  OPENCODE_PURE: 'false',
  OPENCODE_CONFIG: '',
  OPENCODE_CONFIG_CONTENT: '',
  OPENCODE_SERVER_PASSWORD: '',
  GREATPING_TEST_SERVICE: 'https://api.greatping.com',
  GREATPING_TEST_RECORD: record,
};
const children = new Set();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const calls = () =>
  existsSync(record)
    ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    cwd: temporary,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(
    args.includes('status') && args.includes('--json') && result.status === 1 ? 0 : result.status,
    0,
    `${args.join(' ')}: ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}
function start(command, args) {
  const child = spawn(command, args, { env, cwd: temporary, stdio: 'pipe' });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
let piSkillSeen = false;
const model = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  const messages = body.messages ?? [];
  if (JSON.stringify(messages).includes('<name>greatping</name>')) piSkillSeen = true;
  const prompt = JSON.stringify(messages.filter((m) => m.role === 'user'));
  const tool = prompt.includes('native-question')
    ? 'question'
    : prompt.includes('native-permission')
      ? 'bash'
      : prompt.includes('native-status')
        ? 'greatping_get_status'
        : null;
  const answered = messages.some((m) => m.role === 'tool');
  const delta =
    tool && !answered
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'fixture-call',
              type: 'function',
              function: {
                name: tool,
                arguments: JSON.stringify(
                  tool === 'question'
                    ? {
                        questions: [
                          {
                            question: 'fixture-private-question',
                            header: 'Fixture',
                            options: [{ label: 'Yes', description: 'Continue' }],
                          },
                        ],
                      }
                    : tool === 'bash'
                      ? { command: 'printf fixture', description: 'Fixture permission' }
                      : {},
                ),
              },
            },
          ],
        }
      : { content: 'Fixture complete.' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason) => ({
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'echo',
    choices: [{ index: 0, delta, finish_reason }],
  });
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...delta }, null))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, tool && !answered ? 'tool_calls' : 'stop'))}\n\n`);
  res.end('data: [DONE]\n\n');
});

try {
  for (const path of [home, config, bin, env.PI_CODING_AGENT_DIR, env.OPENCODE_CONFIG_DIR])
    mkdirSync(path, { recursive: true });
  // Resolve host launchers once before narrowing PATH (the installed Pi is JS).
  const which = (name) => spawnSync('/usr/bin/which', [name], { encoding: 'utf8' }).stdout.trim();
  const opencode = which('opencode');
  const pi = which('pi');
  assert.ok(opencode && pi, 'Install both hosts before native qualification.');
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(pi, join(bin, 'pi'));
  symlinkSync(opencode, join(bin, 'opencode'));
  env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
  const versions = [run(opencode, ['--version']).trim(), run(pi, ['--version']).trim()];
  for (const host of ['opencode', 'pi']) {
    run(process.execPath, [cli, 'setup', host, '--yes']);
    run(process.execPath, [cli, 'setup', host, '--yes']);
  }
  const status = JSON.parse(run(process.execPath, [cli, 'status', '--json']));
  for (const host of ['opencode', 'pi'])
    assert.equal(status.plugins.find((p) => p.id === host)?.status, 'ready');
  await new Promise((done) => model.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
  json(join(env.PI_CODING_AGENT_DIR, 'models.json'), {
    providers: {
      fixture: {
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: 'fixture',
        models: [{ id: 'echo' }],
      },
    },
  });
  json(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), {
    model: 'fixture/echo',
    enabled_providers: ['fixture'],
    autoupdate: false,
    permission: { bash: 'ask' },
    provider: {
      fixture: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fixture',
        options: { baseURL: endpoint, apiKey: 'fixture' },
        models: {
          echo: { name: 'Echo', tool_call: true, limit: { context: 128000, output: 4096 } },
        },
      },
    },
  });
  // Pair only to the test transport. All inherited Node children record calls;
  // the fixture rejects every unexpected route and does not use the network.
  const fetchFixture = join(root, 'apps/cli/test/fixtures/hook-fetch.mjs');
  const transport = join(temporary, 'transport.mjs');
  writeFileSync(
    transport,
    `const original = globalThis.fetch;
await import(${JSON.stringify(pathToFileURL(fetchFixture).href)});
const recorded = globalThis.fetch;
globalThis.fetch = (url, options) => new URL(url).hostname === '127.0.0.1'
  ? original(url, options) : recorded(url, options);`,
  );
  env.NODE_OPTIONS = `--import=${pathToFileURL(transport).href}`;
  async function piPrompt(prompt) {
    const child = start(pi, [
      '--offline',
      '--mode',
      'json',
      '-p',
      '--no-session',
      '--no-context-files',
      '--no-approve',
      '--provider',
      'fixture',
      '--model',
      'echo',
      prompt,
    ]);
    child.stdin.end();
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    let timer;
    try {
      const [code] = await Promise.race([
        once(child, 'close'),
        new Promise((_done, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Pi print timed out: ${output} ${error}`)),
            30000,
          );
        }),
      ]);
      assert.equal(code, 0, error);
      assert.match(output, /agent_settled/);
      return output.trim().split('\n').filter(Boolean).map(JSON.parse);
    } finally {
      clearTimeout(timer);
    }
  }
  const toolEvents = await piPrompt('native-status');
  const toolResult = toolEvents.find(
    (e) => e.type === 'tool_execution_end' && e.toolName === 'greatping_get_status',
  );
  assert.ok(toolResult, 'Pi invoked the native GreatPing status tool');
  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.result.details.connection, 'unpaired');
  assert.ok(piSkillSeen, 'Pi loaded the bundled GreatPing skill into the model context');
  json(join(config, 'greatping/config.json'), {
    apiUrl: 'https://api.greatping.com',
    machineId: 'test-machine',
    machineToken: 'test-token',
  });
  mkdirSync(join(config, 'greatping/hook-state'), { recursive: true });
  writeFileSync(join(config, 'greatping/hook-state/report.seen'), '');
  console.log('Native setup passed; running Pi fixture model.');
  await piPrompt('native-finished');
  await until(
    () => calls().some((c) => c.body?.host === 'pi' && c.body.reason === 'finished'),
    'Pi settled completion',
  );

  // RPC is Pi's real dialog-capable mode; an auxiliary extension opens its UI
  // while GreatPing observes native start/end events without wrapping that UI.
  const uiExtension = join(temporary, 'fixture-ui.js');
  writeFileSync(
    uiExtension,
    `export default (pi) => {
    pi.registerCommand('fixture-ui', {description:'fixture', handler: async (_args,ctx) => {
      await ctx.ui.confirm('fixture-private-ui-title','fixture-private-ui-body');
    }});
    pi.registerCommand('fixture-tools', {description:'fixture', handler: async (_args,ctx) => {
      ctx.ui.notify(JSON.stringify(pi.getAllTools().filter(t=>t.name.startsWith('greatping_')).map(t=>t.name)), 'info');
    }});
  };`,
  );
  const rpc = start(pi, [
    '--offline',
    '--mode',
    'rpc',
    '--no-session',
    '--no-context-files',
    '--no-approve',
    '--provider',
    'fixture',
    '--model',
    'echo',
    '-e',
    uiExtension,
  ]);
  const lines = createInterface({ input: rpc.stdout });
  const rpcEvents = [];
  lines.on('line', (line) => {
    try {
      rpcEvents.push(JSON.parse(line));
    } catch {
      /* fixture diagnostic */
    }
  });
  const send = (value) => rpc.stdin.write(`${JSON.stringify(value)}\n`);
  send({ type: 'prompt', message: '/fixture-tools' });
  await until(
    () => rpcEvents.some((e) => e.type === 'extension_ui_request' && e.method === 'notify'),
    'Pi tool inventory',
  );
  const inventory = rpcEvents.find(
    (e) => e.type === 'extension_ui_request' && e.method === 'notify',
  );
  assert.deepEqual(JSON.parse(inventory.message).sort(), [
    'greatping_ask_user',
    'greatping_get_status',
    'greatping_notify',
    'greatping_pause_alerts',
    'greatping_resume_alerts',
  ]);
  send({ type: 'prompt', message: '/fixture-ui' });
  await until(
    () => rpcEvents.some((e) => e.type === 'extension_ui_request' && e.method === 'confirm'),
    'Pi blocking UI',
  );
  const dialog = rpcEvents.find((e) => e.type === 'extension_ui_request' && e.method === 'confirm');
  await until(
    () => calls().some((c) => c.body?.host === 'pi' && c.body.reason === 'input'),
    'Pi UI attention',
  );
  const opened = calls().find((c) => c.body?.host === 'pi' && c.body.reason === 'input').body;
  send({ type: 'extension_ui_response', id: dialog.id, confirmed: true });
  await until(
    () =>
      calls().some(
        (c) => c.path.endsWith('/resolve') && c.body?.correlation === opened.correlation,
      ),
    'Pi UI close',
  );
  const rpcClosed = once(rpc, 'close');
  rpc.stdin.end();
  await rpcClosed;
  lines.close();
  assert.ok(!JSON.stringify(calls()).includes('fixture-private-ui'), 'Pi UI contents stayed local');

  console.log('Pi completion passed; starting OpenCode fixture server.');
  const server = start(opencode, [
    '--print-logs',
    '--log-level',
    'DEBUG',
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  let serverOutput = '';
  let serverError = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverError += chunk;
  });
  await until(
    () => /http:\/\/127\.0\.0\.1:\d+/.test(serverOutput),
    `OpenCode serve startup ${serverError}`,
  );
  const url = serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const request = async (path, body) => {
    const response = await fetch(`${url}${path}?directory=${encodeURIComponent(temporary)}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  for (const marker of ['native-finished', 'native-question', 'native-permission']) {
    console.log(`OpenCode: ${marker}`);
    const session = await request('/session', {});
    const pending = request(`/session/${session.id}/message`, {
      parts: [{ type: 'text', text: marker }],
    });
    if (marker !== 'native-finished') {
      const reason = marker === 'native-question' ? 'question' : 'permission';
      await until(
        () => calls().some((c) => c.body?.host === 'opencode' && c.body.reason === reason),
        `${reason}; ${serverError}`,
      );
      const openedPrompt = calls().find(
        (c) => c.body?.host === 'opencode' && c.body.reason === reason,
      ).body;
      const kind = reason === 'question' ? 'question' : 'permission';
      const prompts = await request(`/${kind}`);
      const prompt = prompts.find((p) => p.sessionID === session.id);
      assert.ok(prompt, `${kind} prompt belongs to session`);
      await request(
        `/${kind}/${prompt.id}/reply`,
        reason === 'question' ? { answers: [['Yes']] } : { reply: 'once' },
      );
      await until(
        () =>
          calls().some(
            (c) => c.path.endsWith('/resolve') && c.body?.correlation === openedPrompt.correlation,
          ),
        `OpenCode ${reason} close correlates with its open`,
      );
    }
    const result = await pending;
    assert.equal(result.info?.error, undefined, JSON.stringify(result.info?.error));
    if (marker === 'native-finished') {
      const cfg = await request('/config');
      assert.ok(cfg.mcp?.greatping, `Plugin config missing: ${serverError}`);
      await until(
        () => calls().some((c) => c.body?.host === 'opencode' && c.body.reason === 'finished'),
        'OpenCode first completion',
      );
    }
  }
  await until(
    () =>
      calls().filter((c) => c.body?.host === 'opencode' && c.body.reason === 'finished').length >=
      3,
    'OpenCode completions',
  );
  const effective = await request('/config');
  assert.equal(effective.mcp.greatping.type, 'local');
  assert.ok(effective.skills.paths.some((p) => p.includes('greatping/adapters/opencode/skills')));
  assert.ok(
    calls().every((c) => !c.unexpected),
    'Only expected GreatPing fixture requests',
  );
  assert.ok(
    !JSON.stringify(calls()).includes('fixture-private-question'),
    'Native prompt text stayed local',
  );
  delete env.NODE_OPTIONS;
  for (const host of ['opencode', 'pi'])
    run(process.execPath, [cli, 'setup', host, '--remove', '--yes']);
  assert.equal(
    JSON.parse(readFileSync(join(config, 'greatping/config.json'), 'utf8')).machineToken,
    'test-token',
  );
  console.log(
    `Verified native OpenCode ${versions[0]} and Pi ${versions[1]}: repeatable setup, real model-loop completion, OpenCode question/permission lifecycle, Pi UI lifecycle and native tool execution, MCP registration, bundled skills and removal preserving pairing. Fixture transport only; no phone delivery.`,
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
