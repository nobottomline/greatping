import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { DEFAULT_API_URL } from '../src/config.ts';

async function session(mode, run, paired = true) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-mcp-'));
  const cfg = join(root, '.config', 'greatping');
  mkdirSync(cfg, { recursive: true });
  const config = join(cfg, 'config.json');
  if (paired)
    writeFileSync(
      config,
      JSON.stringify({
        apiUrl: DEFAULT_API_URL,
        machineId: 'test-machine',
        machineToken: 'PRIVATE TOKEN',
      }),
    );
  const before = paired ? readFileSync(config, 'utf8') : null;
  const log = join(root, 'calls.jsonl');
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./fixtures/operations-fetch.mjs', import.meta.url).pathname,
      process.env.GREATPING_TEST_CLI ?? new URL('../dist/index.js', import.meta.url).pathname,
      'mcp',
    ],
    {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, '.config'),
        CODEX_HOME: join(root, '.codex'),
        GREATPING_TEST_MODE: mode,
        GREATPING_TEST_LOG: log,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let id = 0,
    stderr = '';
  const pending = new Map();
  child.stderr.on('data', (s) => {
    stderr += s;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const wait = pending.get(message.id);
    if (wait) {
      pending.delete(message.id);
      clearTimeout(wait.timer);
      wait.resolve(message);
    }
  });
  const request = (method, params = {}) => {
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP timeout ${method}: ${stderr}`));
      }, 4000);
      pending.set(requestId, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return { id: requestId, promise };
  };
  const notify = (method, params = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  try {
    const init = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }).promise;
    assert.equal(init.error, undefined, JSON.stringify(init));
    notify('notifications/initialized');
    await run({
      request,
      notify,
      log,
      root,
      calls: () =>
        existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    });
    assert.equal(paired ? readFileSync(config, 'utf8') : null, before);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
    lines.close();
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error('MCP closed'));
    }
    rmSync(root, { recursive: true, force: true });
  }
}
const call = async (request, name, args = {}) => {
  const response = await request('tools/call', { name, arguments: args }).promise;
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
};

test('MCP advertises five tools with output schemas and correct annotations', async () => {
  await session('answered', async ({ request }) => {
    const response = await request('tools/list').promise;
    assert.equal(response.error, undefined, JSON.stringify(response));
    const tools = response.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'ask_user',
      'get_status',
      'notify',
      'pause_alerts',
      'resume_alerts',
    ]);
    for (const tool of tools) {
      assert.ok(tool.outputSchema);
      assert.equal(tool.outputSchema.type, 'object');
    }
    assert.equal(tools.find((t) => t.name === 'get_status').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'notify').annotations.idempotentHint, false);
  });
});
test('MCP status is read only and does not expose credentials or device names', async () => {
  await session('answered', async ({ request, calls, root }) => {
    const result = await call(request, 'get_status');
    assert.equal(result.structuredContent.connection, 'connected');
    assert.equal(result.structuredContent.deviceCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-account/);
    assert.deepEqual(
      calls().map((c) => [c.method, c.path]),
      [['GET', '/v1/machine/me']],
    );
    assert.equal(existsSync(join(root, '.config', 'greatping', 'installation.json')), false);
  });
});
test('MCP status distinguishes unpaired, revoked and unreachable', async () => {
  for (const [mode, paired, expected] of [
    ['answered', false, 'unpaired'],
    ['revoked', true, 'revoked'],
    ['network', true, 'unreachable'],
  ]) {
    await session(
      mode,
      async ({ request, calls }) => {
        const result = await call(request, 'get_status');
        assert.equal(result.structuredContent.connection, expected);
        assert.equal(result.structuredContent.deviceCount, null);
        if (!paired) assert.equal(calls().length, 0);
      },
      paired,
    );
  }
});
test('MCP notify returns accepted/paused and supports titles without claiming delivery', async () => {
  for (const mode of ['answered', 'paused'])
    await session(mode, async ({ request, calls }) => {
      const result = await call(request, 'notify', { message: 'Build complete', title: 'CI' });
      assert.deepEqual(result.structuredContent, {
        requestId: 'test-request',
        status: mode === 'paused' ? 'paused' : 'accepted',
      });
      assert.equal(calls()[0].body.title, 'CI');
      assert.doesNotMatch(result.content[0].text, /delivered|Notification sent/);
    });
});
test('MCP pause/resume uses bounded durations and changes only this computer', async () => {
  await session('answered', async ({ request, calls }) => {
    const before = Date.now();
    const paused = await call(request, 'pause_alerts', { durationSeconds: 120 });
    assert.ok(paused.structuredContent.alertsPausedUntil >= before + 120000);
    const resumed = await call(request, 'resume_alerts');
    assert.equal(resumed.structuredContent.alertsPausedUntil, null);
    const invalid = await call(request, 'pause_alerts', { durationSeconds: 0 });
    assert.equal(invalid.isError, true);
    assert.equal(calls().length, 2);
  });
});
test('MCP questions distinguish answers and expiry and accept comma-bearing choices', async () => {
  for (const mode of ['answered', 'expired'])
    await session(mode, async ({ request, calls }) => {
      const result = await call(request, 'ask_user', {
        question: 'Continue?',
        choices: ['Yes, continue', 'No'],
        timeoutSeconds: 10,
      });
      assert.equal(result.structuredContent.status, mode);
      assert.equal(result.structuredContent.requestId, 'test-request');
      assert.deepEqual(calls()[0].body.choices, ['Yes, continue', 'No']);
      assert.equal(Boolean(result.isError), mode === 'expired');
    });
});
test('MCP cancellation during creation withdraws the question once its ID arrives', async () => {
  await session('cancel', async ({ request, notify, calls }) => {
    const pending = request('tools/call', {
      name: 'ask_user',
      arguments: { question: 'Continue?' },
    });
    while (calls().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    notify('notifications/cancelled', { requestId: pending.id, reason: 'User cancelled' });
    // SDK versions may suppress the cancelled response; the server withdrawal
    // is the required externally observable outcome.
    const response = pending.promise.catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      calls().map((c) => c.path),
      ['/v1/requests', '/v1/requests/test-request/cancel'],
    );
    await response;
  });
});
test('MCP failures have a structured error without leaking the credential', async () => {
  await session('revoked', async ({ request }) => {
    const result = await call(request, 'notify');
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.code, 'unauthorized');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE TOKEN/);
  });
});
