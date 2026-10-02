import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const mode = process.argv[2] ?? 'all';
const version = '8.30.1';
const binary =
  process.env.GITLEAKS_BIN ??
  (existsSync('.tools/gitleaks') ? resolve('.tools/gitleaks') : 'gitleaks');
const run = (command, args, cwd = root) =>
  spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });

function fail(message) {
  console.error(message);
  process.exitCode = 2;
}

function scan(command, source, temporary) {
  const report = join(temporary, `${command}.json`);
  const args = [
    command,
    command === 'dir' ? '.' : source,
    '--config',
    join(root, '.gitleaks.toml'),
    '--redact=100',
    '--no-banner',
    '--log-level=error',
    '--ignore-gitleaks-allow',
    '--report-format=json',
    '--report-path',
    report,
  ];
  if (command === 'git') args.push('--log-opts=--all');
  const result = run(binary, args, command === 'dir' ? source : root);
  // Never relay scanner output or upload raw reports: even a redacted match can
  // contain unrelated sensitive text. Only locations and rule IDs leave here.
  if (result.error || ![0, 1].includes(result.status) || !existsSync(report))
    throw new Error(`Gitleaks ${command} scan failed; no successful result was recorded.`);
  let findings;
  try {
    findings = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    throw new Error('Gitleaks returned an unreadable report.');
  }
  if (!Array.isArray(findings) || (result.status === 1 && findings.length === 0))
    throw new Error('Gitleaks returned an inconsistent report.');
  for (const finding of findings)
    console.error(
      JSON.stringify({
        rule: finding.RuleID,
        file: finding.File,
        line: finding.StartLine,
        commit: finding.Commit || undefined,
      }),
    );
  console.log(`Gitleaks ${command}: ${findings.length} findings.`);
  if (findings.length) process.exitCode = 1;
}

const temporary = mkdtempSync(join(tmpdir(), 'greatping-secrets-'));
try {
  if (!['all', 'tree', 'history'].includes(mode))
    throw new Error('Usage: node scripts/quality/check-secrets.mjs [all|tree|history]');
  const installed = run(binary, ['version']);
  if (installed.status !== 0 || installed.stdout.trim() !== version)
    throw new Error(
      `Gitleaks ${version} is required. Run pnpm secrets:install or set GITLEAKS_BIN.`,
    );
  if (mode !== 'tree') {
    const shallow = run('git', ['rev-parse', '--is-shallow-repository']);
    if (shallow.status !== 0 || shallow.stdout.trim() !== 'false')
      throw new Error('History scanning requires a complete Git checkout (fetch-depth: 0).');
    scan('git', root, temporary);
  }
  if (mode !== 'history') {
    const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (listed.status !== 0) throw new Error('Cannot enumerate repository files.');
    const tree = join(temporary, 'tree');
    mkdirSync(tree);
    for (const file of new Set(listed.stdout.split('\0').filter(Boolean))) {
      const source = join(root, file);
      if (!existsSync(source)) continue; // Unstaged deletions are absent from the working tree.
      if (!lstatSync(source).isFile()) continue; // Never follow symlinks into operator files.
      const destination = join(tree, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    scan('dir', tree, temporary);
  }
} catch (error) {
  fail(error.message);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
