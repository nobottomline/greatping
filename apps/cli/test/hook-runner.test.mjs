import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_API_URL } from '../src/config.ts';

const cli =
  process.env.GREATPING_TEST_CLI ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = fileURLToPath(new URL('./fixtures/hook-fetch.mjs', import.meta.url));
const stop = { hook_event_name: 'Stop', session_id: 'fixture-session' };

function withHook(run) {
  const home = mkdtempSync(join(tmpdir(), 'greatping-hook-runner-'));
  const configHome = join(home, '.config');
  const configDir = join(configHome, 'greatping');
  const records = join(home, 'requests.ndjson');
  mkdirSync(join(configDir, 'hook-state'), { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      apiUrl: DEFAULT_API_URL,
      machineId: 'test-machine',
      machineToken: 'test-token',
    }),
    { mode: 0o600 },
  );
  // Machine reporting is covered separately; keep this fixture on the alert path.
  writeFileSync(join(configDir, 'hook-state', 'claude.seen'), '');
  writeFileSync(join(configDir, 'hook-state', 'report.seen'), '');
  const calls = () =>
    existsSync(records)
      ? readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  const hook = (input, { finished = true, entrypoint, disable, fail = false } = {}) => {
    const result = spawnSync(
      process.execPath,
      ['--import', transport, cli, 'hook', 'claude', ...(finished ? ['--finished'] : [])],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          GREATPING_TEST_SERVICE: DEFAULT_API_URL,
          GREATPING_TEST_RECORD: records,
          ...(entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint }),
          ...(disable === undefined ? {} : { GREATPING_DISABLE: disable }),
          ...(fail ? { GREATPING_TEST_FETCH_FAIL: '1' } : {}),
        },
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.ok(
      calls().every((call) => !call.unexpected),
      'unexpected API call',
    );
    return calls();
  };
  try {
    run(hook, calls);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const entrypoint of [undefined, 'cli', 'sdk-ts', 'sdk-py', 'sdk-cli', 'custom-host']) {
  test(`explicit finished alerts work with entrypoint ${entrypoint ?? '(unset)'}`, () => {
    withHook((hook) => {
      const calls = hook({ ...stop, last_assistant_message: 'private reply' }, { entrypoint });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/v1/requests');
      assert.equal(calls[0].entrypoint, entrypoint ?? null);
      assert.equal(calls[0].body.kind, 'attention');
      assert.equal(calls[0].body.host, 'claude-code');
      assert.equal(calls[0].body.reason, 'finished');
      assert.deepEqual(calls[0].body.content, { enc: 0 });
      assert.ok(calls[0].body.thread);
      assert.ok(!JSON.stringify(calls).includes('private reply'));
      assert.ok(!JSON.stringify(calls).includes(stop.session_id));
    });
  });
}

test('SDK completion alerts remain opt-in and support a session opt-out', () => {
  for (const options of [{ finished: false }, { disable: '1' }, { disable: 'true' }]) {
    withHook((hook) => assert.deepEqual(hook(stop, { entrypoint: 'sdk-ts', ...options }), []));
  }
  withHook((hook) => assert.equal(hook(stop, { entrypoint: 'sdk-ts', disable: '0' }).length, 1));
});

test('SDK hooks resolve completion alerts when the next prompt arrives', () => {
  withHook((hook) => {
    const [opened] = hook(stop, { entrypoint: 'sdk-ts' });
    const calls = hook(
      { hook_event_name: 'UserPromptSubmit', session_id: stop.session_id },
      { entrypoint: 'sdk-ts' },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/v1/requests/resolve');
    assert.deepEqual(calls[1].body, { host: 'claude-code', thread: opened.body.thread });
  });
});

test('a recursive Stop resolves the SDK alert without opening another', () => {
  withHook((hook) => {
    const [opened] = hook(stop, { entrypoint: 'sdk-ts' });
    const calls = hook({ ...stop, stop_hook_active: true }, { entrypoint: 'sdk-ts' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/v1/requests/resolve');
    assert.deepEqual(calls[1].body, { host: 'claude-code', thread: opened.body.thread });
  });
});

test('hook transport failures remain silent and do not fail Claude', () => {
  withHook((hook) => assert.equal(hook(stop, { entrypoint: 'sdk-ts', fail: true }).length, 1));
});

test('malformed or oversized hook input never reaches the transport', () => {
  withHook((hook) => {
    assert.deepEqual(hook('not JSON'), []);
    assert.deepEqual(hook(JSON.stringify({ ...stop, padding: 'x'.repeat(256 * 1024) })), []);
  });
});
