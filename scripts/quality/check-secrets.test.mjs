import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
const binary = process.env.GITLEAKS_BIN ?? resolve('.tools/gitleaks');
const key = () => `AI${'za'}${randomBytes(32).toString('base64url').slice(0, 35)}`;

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'greatping-secrets-test-'));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd: root, stdio: 'pipe' },
    );
  const check = (mode) =>
    spawnSync(process.execPath, [scanner, mode], {
      cwd: root,
      env: { ...process.env, GITLEAKS_BIN: binary },
      encoding: 'utf8',
    });
  try {
    git('init');
    copyFileSync(new URL('../../.gitleaks.toml', import.meta.url), join(root, '.gitleaks.toml'));
    writeFileSync(join(root, '.gitignore'), '.env\nnode_modules/\n');
    git('add', '.');
    git('commit', '-m', 'clean fixture');
    run({ root, git, check });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('working tree checks new and modified files without printing secret values', () =>
  fixture(({ root, git, check }) => {
    assert.equal(check('all').status, 0);
    const secret = key();
    writeFileSync(join(root, 'candidate.json'), JSON.stringify({ api_key: secret }));
    const result = check('tree');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gcp-api-key/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    writeFileSync(join(root, 'candidate.json'), '{}');
    git('add', 'candidate.json');
    git('commit', '-m', 'safe tracked file');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify({ api_key: secret }));
    assert.equal(check('tree').status, 1);
    writeFileSync(join(root, 'candidate.json'), '{}');
    writeFileSync(join(root, '.env'), `API_KEY=${secret}`);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/ignored.json'), JSON.stringify({ api_key: secret }));
    assert.equal(check('all').status, 0);
  }));

test('history detects a credential deleted from the current tree', () =>
  fixture(({ root, git, check }) => {
    const secret = key();
    writeFileSync(join(root, 'past.json'), JSON.stringify({ api_key: secret }));
    git('add', 'past.json');
    git('commit', '-m', 'synthetic historical credential');
    git('rm', 'past.json');
    git('commit', '-m', 'remove synthetic credential');
    assert.equal(check('tree').status, 0);
    const result = check('history');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /past.json/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  }));

test('history refuses shallow checkouts and a missing scanner fails closed', () =>
  fixture(({ root, git, check }) => {
    const commit = git('rev-parse', 'HEAD').toString().trim();
    writeFileSync(join(root, '.git/shallow'), `${commit}\n`);
    const shallow = check('history');
    assert.equal(shallow.status, 2);
    assert.match(shallow.stderr, /complete Git checkout/);
    const missing = spawnSync(process.execPath, [scanner, 'tree'], {
      cwd: root,
      env: { ...process.env, GITLEAKS_BIN: join(root, 'absent-scanner') },
      encoding: 'utf8',
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Gitleaks 8\.30\.1 is required/);
  }));

test('Firebase exception is limited to its client field, path and rule', () =>
  fixture(({ root, check }) => {
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    const publicField = JSON.stringify({ current_key: key() }, null, 2);
    writeFileSync(join(root, 'apps/mobile/google-services.json'), publicField);
    assert.equal(check('tree').status, 0);
    writeFileSync(join(root, 'other.json'), publicField);
    assert.equal(check('tree').status, 1);
    rmSync(join(root, 'other.json'));
    writeFileSync(
      join(root, 'apps/mobile/google-services.json'),
      JSON.stringify({ private_key: key() }, null, 2),
    );
    assert.equal(check('tree').status, 1);
    const token = `gh${'p_'}${randomBytes(32).toString('hex').slice(0, 36)}`;
    writeFileSync(
      join(root, 'apps/mobile/google-services.json'),
      JSON.stringify({ current_key: token }, null, 2),
    );
    const result = check('tree');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /github-pat/);
    assert.ok(!result.stderr.includes(token));
  }));
