import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateVersion(version) {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
  );
  return version;
}

export async function readJson(url, { fetcher = fetch, token } = {}) {
  const response = await fetcher(url, {
    headers: token
      ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
      : {},
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Release lookup failed: HTTP ${response.status} at ${new URL(url).host}.`);
  return response.json();
}

export function releasePlan({ version, published, release, tagCommit, headCommit, npmEnabled }) {
  validateVersion(version);
  assert.ok(!release?.draft, 'An incomplete draft needs explicit recovery before release.');
  if (published) {
    assert.equal(published.version, version, 'Registry version mismatch.');
    assert.ok(
      release && tagCommit,
      'Published version has no matching GitHub release/tag; recover it explicitly.',
    );
    return {
      version,
      source: tagCommit,
      work: false,
      existing: true,
      published: true,
      stage: false,
    };
  }
  if (release) {
    assert.ok(tagCommit, 'Existing release has no source tag.');
    assert.equal(
      release.immutable,
      true,
      'An unpublished mutable release needs explicit recovery.',
    );
  } else
    assert.equal(tagCommit, null, 'A tag without release assets must be recovered explicitly.');
  return {
    version,
    source: tagCommit ?? headCommit,
    work: !release || npmEnabled,
    existing: Boolean(release),
    published: false,
    stage: npmEnabled,
  };
}

export function artifactMetadata(bytes, version, source) {
  validateVersion(version);
  assert.match(source, /^[a-f0-9]{40}$/);
  return {
    version,
    source,
    file: 'greatping.tgz',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export function verifyArtifact(bytes, metadata, version, source) {
  assert.deepEqual(
    metadata,
    artifactMetadata(bytes, version, source),
    'Release archive or source identity changed.',
  );
}

async function main() {
  const [mode, directory, expectedVersion, expectedSource] = process.argv.slice(2);
  if (mode === 'state') {
    const version = validateVersion(
      JSON.parse(readFileSync('apps/cli/package.json', 'utf8')).version,
    );
    const repository = process.env.GITHUB_REPOSITORY;
    assert.equal(
      repository,
      'nobottomline/greatping',
      'Release runs only in the public repository.',
    );
    const published = await readJson(`https://registry.npmjs.org/greatping/${version}`);
    const release = await readJson(
      `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
      { token: process.env.GH_TOKEN },
    );
    let tagCommit = null;
    try {
      tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/v${version}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* No tag is the normal first-release case. */
    }
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const plan = releasePlan({
      version,
      published,
      release,
      tagCommit,
      headCommit,
      npmEnabled: process.env.NPM_PUBLISH === 'true',
    });
    for (const [key, value] of Object.entries(plan))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      plan.published
        ? `greatping@${version} is already published. No package was built or published by this run.\n`
        : `greatping@${version}: ${plan.existing ? 'reuse immutable release assets' : 'build and qualify one archive'}. npm staging ${plan.stage ? 'enabled; approval is separate' : 'disabled'}.\n`,
    );
    return;
  }
  assert.ok(mode === 'record' || mode === 'verify', 'Use state, record or verify.');
  const archive = readFileSync(resolve(directory, 'greatping.tgz'));
  const metadataPath = resolve(directory, 'release.json');
  if (mode === 'record') {
    const metadata = artifactMetadata(archive, expectedVersion, expectedSource);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(resolve(directory, 'SHA256SUMS'), `${metadata.sha256}  greatping.tgz\n`);
  } else {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    verifyArtifact(archive, metadata, expectedVersion, expectedSource);
    assert.equal(
      readFileSync(resolve(directory, 'SHA256SUMS'), 'utf8'),
      `${metadata.sha256}  greatping.tgz\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
