import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import OpenCode from '../plugins/opencode/greatping/index.js';
import { events, mcp } from '../plugins/shared/native.mjs';

async function fixture(t, action) {
  const root = mkdtempSync(join(tmpdir(), 'greatping adapter conformance '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const log = join(root, 'events.ndjson');
  const cli = join(root, 'cli.mjs');
  writeFileSync(
    cli,
    `import {appendFileSync} from 'node:fs';
if (process.argv.includes('mcp')) {
  const {createInterface} = await import('node:readline');
  createInterface({input:process.stdin}).on('line', line => {
    const p=JSON.parse(line);
    if (p.method==='tools/call') appendFileSync(${JSON.stringify(log)},line+'\\n');
    if (p.method==='notifications/cancelled') appendFileSync(${JSON.stringify(log)},line+'\\n');
    else if (p.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));
  });
} else {
  let text=''; for await (const c of process.stdin) text+=c;
  await new Promise(r=>setTimeout(r,25));
  appendFileSync(${JSON.stringify(log)},text+'\\n');
}`,
  );
  mkdirSync(join(root, 'greatping/plugins'), { recursive: true });
  for (const host of ['opencode', 'pi'])
    writeFileSync(
      join(root, 'greatping/plugins', `${host}.json`),
      JSON.stringify({
        version: 1,
        launcher: { command: process.execPath, args: [cli] },
        finished: true,
        alerts: ['questions', 'permissions', 'tool-input'],
      }),
    );
  const records = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  try {
    await action({ root, records });
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
}

test('OpenCode strips private prompts, preserves order and suppresses child/error/duplicate completion', async (t) =>
  fixture(t, async ({ records }) => {
    const plugin = await OpenCode.server({
      directory: '/project',
      client: { session: { get: async () => ({ data: { parentID: 'parent' } }) } },
    });
    const emit = (type, properties) => plugin.event({ event: { type, properties } });
    for (const [id, parentID] of [
      ['root', undefined],
      ['child', 'root'],
    ]) {
      await emit('session.created', { info: { id, parentID } });
      await emit('session.status', { sessionID: id, status: { type: 'busy' } });
      await emit('question.asked', { sessionID: id, id: 'q1', questions: ['private question'] });
      await emit('question.rejected', {
        sessionID: id,
        requestID: 'q1',
        answers: ['private answer'],
      });
      await emit('session.idle', { sessionID: id });
      await emit('session.idle', { sessionID: id });
    }
    await emit('session.status', { sessionID: 'root', status: { type: 'busy' } });
    await emit('session.error', { sessionID: 'root', error: { message: 'private error' } });
    await emit('session.idle', { sessionID: 'root' });
    const config = {
      mcp: { greatping: { type: 'remote', url: 'user-managed' } },
      skills: { paths: ['/existing'] },
    };
    await plugin.config(config);
    assert.equal(config.mcp.greatping.url, 'user-managed');
    assert.equal(config.skills.paths[0], '/existing');
    await plugin.dispose();
    assert.equal(records().filter((r) => r.hook_event_name === 'Finished').length, 1);
    assert.equal(records().filter((r) => r.hook_event_name === 'PromptOpen').length, 2);
    assert.equal(JSON.stringify(records()).includes('private'), false);
    const names = records()
      .filter((r) => r.session_id === 'root')
      .map((r) => r.hook_event_name);
    assert.deepEqual(names.slice(0, 4), ['Started', 'PromptOpen', 'PromptClose', 'Finished']);
  }));

test('native queue fails open for missing settings and honours session opt-out', async (t) =>
  fixture(t, async ({ root, records }) => {
    const before = process.env.GREATPING_DISABLE;
    process.env.GREATPING_DISABLE = '1';
    const queue = events('pi');
    queue.send({ hook_event_name: 'Finished', session_id: 'session' });
    await queue.close();
    assert.deepEqual(records(), []);
    if (before === undefined) delete process.env.GREATPING_DISABLE;
    else process.env.GREATPING_DISABLE = before;
    rmSync(join(root, 'greatping/plugins/pi.json'));
    const unconfigured = events('pi');
    unconfigured.send({ hook_event_name: 'Finished', session_id: 'session' });
    await unconfigured.close();
    assert.deepEqual(records(), []);
  }));

test('native MCP cancellation reaches the runtime before the child is stopped', async (t) =>
  fixture(t, async ({ records }) => {
    const controller = new AbortController();
    const result = mcp(
      'pi',
      'tools/call',
      { name: 'ask_user', arguments: { question: 'fixture', timeoutSeconds: 10 } },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(result, /cancelled/);
    for (let i = 0; i < 100 && !records().some((r) => r.method === 'tools/call'); i++)
      await new Promise((done) => setTimeout(done, 25));
    assert.ok(
      records().some((r) => r.method === 'tools/call'),
      'MCP tool request reached runtime',
    );
    controller.abort();
    await rejected;
    assert.equal(
      records().find((r) => r.method === 'notifications/cancelled')?.params.requestId,
      2,
    );
  }));

test('OpenCode suppresses completion when a late session lookup overlaps an error', async (t) =>
  fixture(t, async ({ records }) => {
    let finishLookup;
    const lookup = new Promise((done) => {
      finishLookup = done;
    });
    const plugin = await OpenCode.server({
      directory: '/project',
      client: { session: { get: () => lookup } },
    });
    const emit = (type, properties) => plugin.event({ event: { type, properties } });
    await emit('session.status', { sessionID: 'existing', status: { type: 'busy' } });
    const idle = emit('session.idle', { sessionID: 'existing' });
    await emit('session.error', { sessionID: 'existing' });
    finishLookup({ data: { id: 'existing' } });
    await idle;
    await plugin.dispose();
    assert.equal(
      records().some((r) => r.hook_event_name === 'Finished'),
      false,
    );
    assert.equal(
      records().some((r) => r.hook_event_name === 'SessionEnd'),
      true,
    );
  }));
