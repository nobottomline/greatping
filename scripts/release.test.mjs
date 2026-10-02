import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactMetadata,
  readJson,
  releasePlan,
  validateVersion,
  verifyArtifact,
} from './release.mjs';

const source = 'a'.repeat(40);
const state = {
  version: '0.2.0',
  published: null,
  release: null,
  tagCommit: null,
  headCommit: source,
  npmEnabled: true,
};

test('a fresh version builds once, and an existing release reuses its tagged source', () => {
  assert.deepEqual(releasePlan(state), {
    version: '0.2.0',
    source,
    work: true,
    existing: false,
    published: false,
    stage: true,
  });
  const oldSource = 'b'.repeat(40);
  assert.equal(
    releasePlan({ ...state, release: { immutable: true }, tagCommit: oldSource }).source,
    oldSource,
  );
  assert.equal(releasePlan({ ...state, npmEnabled: false }).stage, false);
});

test('published versions are explicit no-ops; incomplete release state fails closed', () => {
  assert.equal(
    releasePlan({ ...state, release: {}, tagCommit: source, published: { version: '0.2.0' } }).work,
    false,
  );
  assert.throws(() => releasePlan({ ...state, published: { version: '0.2.0' } }));
  assert.throws(() => releasePlan({ ...state, tagCommit: source }));
  assert.throws(() => releasePlan({ ...state, release: {} }));
  assert.throws(() => releasePlan({ ...state, release: { draft: true }, tagCommit: source }));
  assert.throws(() => releasePlan({ ...state, release: { immutable: false }, tagCommit: source }));
  assert.equal(
    releasePlan({ ...state, release: { immutable: true }, tagCommit: source, npmEnabled: false })
      .work,
    false,
  );
});

test('only a registry 404 means absent; outages and denied access block a release', async () => {
  assert.equal(
    await readJson('https://registry.npmjs.org/example', {
      fetcher: async () => new Response('', { status: 404 }),
    }),
    null,
  );
  for (const status of [401, 403, 429, 500, 503])
    await assert.rejects(
      readJson('https://registry.npmjs.org/example', {
        fetcher: async () => new Response('', { status }),
      }),
      /lookup failed/,
    );
  await assert.rejects(
    readJson('https://registry.npmjs.org/example', {
      fetcher: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
});

test('the archive, version and source commit must all match on a retry', () => {
  const bytes = Buffer.from('archive');
  const metadata = artifactMetadata(bytes, '0.2.0', source);
  verifyArtifact(bytes, metadata, '0.2.0', source);
  assert.throws(() => verifyArtifact(Buffer.from('changed'), metadata, '0.2.0', source));
  assert.throws(() => verifyArtifact(bytes, metadata, '0.2.1', source));
  assert.throws(() => verifyArtifact(bytes, metadata, '0.2.0', 'b'.repeat(40)));
  for (const version of ['../bad', '1.2', '01.2.3', '1.2.3\nwork=true'])
    assert.throws(() => validateVersion(version));
});
