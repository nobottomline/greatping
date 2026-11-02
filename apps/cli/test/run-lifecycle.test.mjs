import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = process.env.GREATPING_TEST_CLI ?? new URL('../dist/index.js', import.meta.url).pathname;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function environment(root) {
  return { ...process.env, XDG_CONFIG_HOME: root, NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
}
test('run preserves every child argument after --, including global-looking flags', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'greatping run argv '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'argv.json');
  const args = ['--no-color', '--no-update-check', '--help', '--', '--no-color'];
  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--no-color',
      'run',
      '--on-fail',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify(process.argv.slice(1)))`,
      '--',
      ...args,
    ],
    { env: environment(root), encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), args);
});
for (const signal of ['SIGTERM', 'SIGINT'])
  test(`wrapper-targeted ${signal} stops an owned process group and suppresses completion after exit 0`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'greatping run signal '));
    const log = join(root, 'signals.json');
    const script = join(root, 'command.mjs');
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
process.on(${JSON.stringify(signal)},()=>{writeFileSync(${JSON.stringify(log)},'received');process.exit(0)});
console.log(JSON.stringify({child:process.pid,grandchild:grandchild.pid}));setInterval(()=>{},1000);`,
    );
    const wrapper = spawn(process.execPath, [cli, 'run', '--', process.execPath, script], {
      env: environment(root),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      pids;
    wrapper.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    wrapper.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve) => wrapper.once('close', (code) => resolve(code)));
    t.after(() => {
      wrapper.kill('SIGKILL');
      for (const pid of Object.values(pids ?? {})) if (alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    });
    for (let i = 0; i < 200 && !stdout.includes('\n'); i++) await delay(10);
    pids = JSON.parse(stdout.trim());
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    t.after(() => unrelated.kill('SIGKILL'));
    wrapper.kill(signal);
    assert.equal(
      await Promise.race([closed, delay(7000).then(() => 'hung')]),
      signal === 'SIGINT' ? 130 : 143,
    );
    assert.equal(existsSync(log), true, stderr);
    assert.equal(alive(pids.child), false);
    for (let i = 0; i < 100 && alive(pids.grandchild); i++) await delay(10);
    assert.equal(alive(pids.grandchild), false, 'owned grandchild must stop');
    assert.equal(alive(unrelated.pid), true, 'unrelated process must remain alive');
    assert.doesNotMatch(stderr, /Sending completion|could not send|succeeded|failed/);
  });
test('run escalates an ignored cancellation within its bounded shutdown policy', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'greatping run escalation '));
  const wrapper = spawn(
    process.execPath,
    [
      cli,
      'run',
      '--',
      process.execPath,
      '-e',
      "process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)",
    ],
    { env: environment(root), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    wrapper.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  let output = '';
  wrapper.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolve) => wrapper.once('close', resolve));
  for (let i = 0; i < 200 && !output.includes('READY'); i++) await delay(10);
  assert.match(output, /READY/);
  wrapper.kill('SIGTERM');
  assert.equal(await Promise.race([closed, delay(7000).then(() => 'hung')]), 143);
});
