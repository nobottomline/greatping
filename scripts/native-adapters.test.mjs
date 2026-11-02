import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import OpenCode from '../plugins/opencode/greatping/index.js';

const { events, mcp } = await import(
  process.env.GREATPING_TEST_NATIVE ?? new URL('../plugins/shared/native.mjs', import.meta.url)
);

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
    if (p.method==='notifications/cancelled') { appendFileSync(${JSON.stringify(log)},line+'\\n'); console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/greatping/cancellation',params:{requestId:p.params.requestId,confirmed:true}})); }
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

// This drives the built CLI and its actual MCP SDK, not a server that merely
// records receipt of notifications/cancelled. No hosted service is contacted.
async function runtimeFixture(t, mode, action) {
  const root = mkdtempSync(join(tmpdir(), 'greatping real native cancellation '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const cli = new URL('../apps/cli/dist/index.js', import.meta.url).pathname;
  const resolver = new URL('../apps/cli/test/ts-resolve.mjs', import.meta.url).pathname;
  const account = new URL('../apps/cli/test/fixtures/account.mjs', import.meta.url).href;
  const { spawnSync } = await import('node:child_process');
  const paired = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      resolver,
      '--input-type=module',
      '-e',
      `import {pairedConfig} from ${JSON.stringify(account)};console.log(JSON.stringify(pairedConfig('https://api.greatping.com')));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(paired.status, 0, paired.stderr);
  mkdirSync(join(root, 'greatping/plugins'), { recursive: true });
  writeFileSync(join(root, 'greatping/config.json'), paired.stdout, { mode: 0o600 });
  const log = join(root, 'events.ndjson');
  const preload = join(root, 'fetch.mjs');
  writeFileSync(
    preload,
    `import {appendFileSync} from 'node:fs';
const record=(event)=>appendFileSync(${JSON.stringify(log)},JSON.stringify({event,at:Date.now()})+'\\n');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.fetch=async(url,init)=>{
 const path=new URL(url).pathname;
 if(path==='/v1/manifests') return Response.json({manifests:[]});
 if(path==='/v1/requests'&&init.method==='POST') {
  record('creating');await delay(2500);record('created');
  return Response.json({id:'owned-question',status:'pending',expiresAt:Date.now()+60000});
 }
 if(path==='/v1/requests/owned-question/cancel') {
  record('cancelling');await delay(1200);record('cancel-complete');
  return ${mode === 'failure' ? "Response.json({error:{code:'fixture-failed'}},{status:503})" : 'new Response(null,{status:204})'};
 }
 throw Error('unexpected offline fixture route');
};`,
  );
  writeFileSync(
    join(root, 'greatping/plugins/pi.json'),
    JSON.stringify({
      version: 1,
      launcher: { command: process.execPath, args: ['--import', preload, cli] },
      finished: true,
      alerts: ['questions', 'permissions', 'tool-input'],
    }),
  );
  const records = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  try {
    await action({ records });
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
}

for (const mode of ['success', 'failure'])
  test(`native cancellation waits for real delayed CLI creation and withdrawal (${mode})`, async (t) =>
    runtimeFixture(t, mode, async ({ records }) => {
      const controller = new AbortController();
      let complete = false;
      const operation = mcp(
        'pi',
        'tools/call',
        {
          name: 'ask_user',
          arguments: {
            question: 'Offline synthetic cancellation check',
            timeoutSeconds: 10,
          },
        },
        { signal: controller.signal },
      );
      const rejected = assert.rejects(
        operation.finally(() => {
          complete = true;
        }),
        mode === 'success' ? /request was cancelled\.$/ : /withdrawal could not be confirmed/,
      );
      for (let i = 0; i < 200 && !records().some((r) => r.event === 'creating'); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        records().some((r) => r.event === 'creating'),
        'real CLI began question creation',
      );
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(complete, false, 'CLI must stay alive while the request ID is still unknown');
      await rejected;
      assert.deepEqual(
        records().map((r) => r.event),
        ['creating', 'created', 'cancelling', 'cancel-complete'],
      );
    }));

test('native cancellation ignores acknowledgement for another request and bounds runtime failure recovery', async (t) =>
  fixture(t, async ({ root, records }) => {
    writeFileSync(
      join(root, 'cli.mjs'),
      `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(p.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{capabilities:{experimental:{'greatping/cancellation':{version:1,timeoutMs:250}}}}}));
 if(p.method==='tools/call') appendFileSync(${JSON.stringify(join(root, 'events.ndjson'))},line+'\\n');
 if(p.method==='notifications/cancelled') console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/greatping/cancellation',params:{requestId:999,confirmed:true}}));
});`,
    );
    const controller = new AbortController();
    const operation = mcp(
      'pi',
      'tools/call',
      { name: 'ask_user', arguments: { question: 'fixture', timeoutSeconds: 10 } },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(operation, /withdrawal could not be confirmed/);
    for (let i = 0; i < 200 && !records().length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(records().length, 1);
    controller.abort();
    await rejected;
  }));
