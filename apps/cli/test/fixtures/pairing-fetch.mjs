// Simulate a phone approving the displayed code using the real pairing protocol.
// This preload never contacts the hosted service or bypasses key verification.
import assert from 'node:assert/strict';
import { SERVICE_ORIGIN } from '@greatping/protocol';
import {
  addMember,
  createGenesis,
  generateKeys,
  initiatorConfirmed,
  manifestHash,
  respondToCeremony,
} from '@greatping/protocol/crypto';

const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const phone = generateKeys(random);
const genesis = createGenesis({
  account: 'pty-account',
  device: 'pty-phone',
  keys: phone.public,
  secret: phone.secret,
  createdAt: Date.now(),
});
let printed = '';
const originalWrite = process.stderr.write;
process.stderr.write = function (chunk, ...args) {
  printed += String(chunk);
  return originalWrite.call(this, chunk, ...args);
};
let start;
let expectedTag;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, SERVICE_ORIGIN);
  const body = options.body ? JSON.parse(options.body) : undefined;
  if (parsed.pathname === '/v1/pair/start') {
    start = body;
    return Response.json({
      pairingId: 'pty-pair',
      pollSecret: 'test-secret',
      lookup: 'K7QM',
      machineId: 'pty-machine',
      expiresAt: Date.now() + 10000,
      pollIntervalSec: 0,
    });
  }
  if (parsed.pathname === '/v1/pair/pty-pair') {
    const code = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/);
    assert.ok(code, 'the CLI shows the complete code');
    const next = addMember(
      genesis,
      { id: 'pty-phone', secret: phone.secret },
      { kind: 'computer', id: 'pty-machine', ...start.keys },
      Date.now(),
    );
    const answer = respondToCeremony({
      kind: 'pair',
      sessionId: start.session,
      secret: code[1],
      initiatorShare: start.share,
      initiatorKeys: start.keys,
      device: 'pty-phone',
      manifestHash: manifestHash(next),
      random,
    });
    expectedTag = answer.expectedInitiatorTag;
    return Response.json({
      status: 'approved',
      machineId: 'pty-machine',
      machineToken: 'test-token',
      accountId: 'pty-account',
      deviceCount: 1,
      ceremony: {
        share: answer.share,
        device: 'pty-phone',
        manifestHash: manifestHash(next),
        tag: answer.tag,
      },
      manifests: [genesis, next],
    });
  }
  if (parsed.pathname === '/v1/machine/me/ceremony') {
    assert.equal(initiatorConfirmed(expectedTag, body.tag), true);
    return new Response(null, { status: 204 });
  }
  if (parsed.pathname === '/v1/manifests') return Response.json({ manifests: [] });
  if (parsed.pathname === '/v1/machine/me') {
    if (options.method === 'PATCH') return Response.json({});
    return Response.json({ machine: { name: 'PTY Mac', projectLabels: 'hidden' }, devices: [] });
  }
  throw new Error(`Unexpected fixture route ${options.method} ${parsed.pathname}`);
};
