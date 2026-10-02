// Installs the actual npm archive outside the workspace, then exercises its
// executable, offline resources, hooks, MCP transport and interactive setup.
// A prebuilt archive lets CI build on Node 24 and qualify the same bytes on 22.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'greatping-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: cliRoot,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  const archive = process.argv[2] ? resolve(process.argv[2]) : join(temporary, 'greatping.tgz');
  if (!process.argv[2]) run(pnpm, ['pack', '--out', archive]);
  const installation = join(temporary, 'installation');
  run(npm, [
    'install',
    '--prefix',
    installation,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    archive,
  ]);
  const packageRoot = join(installation, 'node_modules', 'greatping');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const executable = join(packageRoot, pkg.bin.greatping);
  assert.ok(readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.ok(statSync(executable).mode & 0o111);
  assert.ok(existsSync(`${executable}.map`));
  assert.equal(
    readFileSync(join(packageRoot, 'dist', 'SKILL.md'), 'utf8'),
    readFileSync(join(cliRoot, '..', '..', 'skills', 'greatping', 'SKILL.md'), 'utf8'),
  );
  assert.equal(existsSync(join(installation, 'node_modules', '@greatping', 'protocol')), false);
  assert.equal(existsSync(join(installation, 'node_modules', 'tsdown')), false);
  const env = {
    ...process.env,
    GREATPING_TEST_CLI: executable,
    GREATPING_TEST_NODE: process.execPath,
  };
  const version = run(process.execPath, [executable, '--version'], { cwd: installation, env });
  assert.equal(version.stdout.trim(), pkg.version);
  assert.equal(version.stderr, '');
  const unsupported = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(
        "Object.defineProperty(process.versions, 'node', { value: '22.19.9' });",
      )}`,
      executable,
      '--version',
    ],
    { cwd: installation, env, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, '');
  assert.ok(unsupported.stderr.includes(`requires Node.js ${pkg.engines.node.slice(2)}`));
  const help = run(process.execPath, [executable, '--help'], { cwd: installation, env });
  assert.match(help.stderr, /GreatPing/);
  run(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--import',
      './test/ts-resolve.mjs',
      '--test',
      'test/hook-runner.test.mjs',
      'test/mcp.test.mjs',
    ],
    { env, stdio: 'inherit' },
  );
  if (process.platform !== 'win32')
    run('python3', ['test/interactive-smoke.py'], { env, stdio: 'inherit' });
  console.log(`Installed npm archive passed on Node ${process.versions.node}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
