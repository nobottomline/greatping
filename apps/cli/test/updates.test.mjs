import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configDir } from '../src/config.ts';
import { checkForUpdates, refreshUpdateCache } from '../src/updates.ts';

async function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-updates-'));
  const previous = process.env.XDG_CONFIG_HOME;
  const original = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = root;
  const file = join(configDir(), 'update-check.json');
  try {
    await run(file);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('npm tag check sends no credentials, refuses redirects and writes a private cache', () =>
  isolated(async (file) => {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://registry.npmjs.org/-/package/greatping/dist-tags');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { accept: 'application/json' });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ latest: '1.10.0', next: '2.0.0-beta.1' });
    };
    await refreshUpdateCache();
    assert.equal(calls, 1);
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(cache.latest, '1.10.0');
    assert.ok(Date.now() - cache.checkedAt < 1000);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test('offline, timeouts, redirects, HTTP errors and invalid tags retain the previous cache', () =>
  isolated(async (file) => {
    mkdirSync(configDir(), { recursive: true });
    const prior = JSON.stringify({
      attemptedAt: Date.now(),
      checkedAt: Date.now(),
      latest: '1.0.0',
    });
    writeFileSync(file, prior);
    const replies = [
      () => {
        throw new Error('offline');
      },
      () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      () => {
        throw new TypeError('redirect refused');
      },
      () => new Response('', { status: 503 }),
      () => new Response('{bad'),
      ...[
        null,
        [],
        {},
        { latest: '99.0.0-beta.1' },
        { latest: '1.0.0\n\u001b[2J' },
        { latest: '01.0.0' },
        { latest: '1.2' },
        { latest: 42 },
      ].map((value) => () => Response.json(value)),
    ];
    for (const reply of replies) {
      globalThis.fetch = async () => reply();
      await refreshUpdateCache();
      assert.equal(readFileSync(file, 'utf8'), prior);
    }
  }));

test('unwritable optional cache never turns an update check into a command failure', () =>
  isolated(async (file) => {
    // A regular file at the directory path fails equally under root and ordinary users.
    writeFileSync(configDir(), 'blocked');
    globalThis.fetch = async () => Response.json({ latest: '1.0.0' });
    await assert.doesNotReject(refreshUpdateCache());
    assert.equal(readFileSync(join(file, '..'), 'utf8'), 'blocked');
  }));

test('a pending check cannot overwrite a newer reservation or recreate an uninstalled cache', () =>
  isolated(async (file) => {
    mkdirSync(configDir(), { recursive: true });
    const attemptedAt = Date.now() - 1000;
    const prior = JSON.stringify({ attemptedAt, checkedAt: 0, latest: null });
    for (const supersede of [
      () => rmSync(file),
      () =>
        writeFileSync(
          file,
          JSON.stringify({ attemptedAt: Date.now(), checkedAt: 0, latest: null }),
        ),
    ]) {
      writeFileSync(file, prior);
      globalThis.fetch = async () => {
        supersede();
        return Response.json({ latest: '99.0.0' });
      };
      await refreshUpdateCache(attemptedAt);
      try {
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).latest, null);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }));

test('explicit checks bypass fresh cached metadata and return honest failure JSON', () =>
  isolated(async (file) => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ attemptedAt: Date.now(), checkedAt: Date.now(), latest: '0.0.0' }),
    );
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = (chunk) => {
      output += chunk;
      return true;
    };
    try {
      globalThis.fetch = async () => Response.json({ latest: '99.0.0' });
      assert.equal(await checkForUpdates({ json: true }), 0);
      assert.equal(JSON.parse(output).latest, '99.0.0');
      assert.equal(JSON.parse(output).updateAvailable, true);
      assert.equal(JSON.parse(readFileSync(file)).latest, '99.0.0');
      output = '';
      globalThis.fetch = async () => {
        throw new Error('offline');
      };
      assert.equal(await checkForUpdates({ json: true }), 1);
      assert.equal(JSON.parse(output).latest, null);
      assert.equal(JSON.parse(output).updateAvailable, null);
      assert.equal(JSON.parse(readFileSync(file)).latest, '99.0.0');
    } finally {
      process.stdout.write = original;
    }
  }));
