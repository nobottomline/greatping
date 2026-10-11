// Simulate a phone approving the displayed code using the real pairing protocol.
// This preload never contacts the hosted service or bypasses key verification.
import assert from 'node:assert/strict';
import { SERVICE_ORIGIN } from '@greatping/protocol';
import {
  addMember,
  createGenesis,
  doneConfirmed,
  generateKeys,
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
let responder;
let approved;
let expectedDone;
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
  if (parsed.pathname === '/v1/pair/pty-pair' && !approved) {
    const code = printed.match(/K7QM-([2-9A-HJ-NP-Z]{4})/);
    assert.ok(code, 'the CLI shows the complete code');
    responder ??= respondToCeremony({
      kind: 'pair',
      session: start.session,
      secret: code[1],
      initiatorShare: start.share,
      initiator: {
        memberId: 'pty-machine',
        name: start.machineName,
        platform: start.platform,
        keys: start.keys,
      },
      responder: { accountId: 'pty-account', deviceId: 'pty-phone' },
      random,
    });
    return Response.json({
      status: 'responded',
      response: { share: responder.share, accountId: 'pty-account', deviceId: 'pty-phone' },
      confirmed: false,
    });
  }
  if (parsed.pathname === '/v1/pair/pty-pair/confirm') {
    assert.equal(responder.confirm(body.tag), true);
    const next = addMember(
      genesis,
      { id: 'pty-phone', secret: phone.secret },
      { kind: 'computer', id: 'pty-machine', ...start.keys },
      Date.now(),
    );
    approved = { approval: responder.approval(next), manifests: [genesis, next] };
    expectedDone = responder.expectedDone(approved.approval.manifestHash);
    return new Response(null, { status: 204 });
  }
  if (parsed.pathname === '/v1/pair/pty-pair') {
    return Response.json({
      status: 'approved',
      machineId: 'pty-machine',
      machineToken: 'test-token',
      accountId: 'pty-account',
      deviceCount: 1,
      ...approved,
    });
  }
  if (parsed.pathname === '/v1/machine/me/ceremony') {
    assert.equal(doneConfirmed(expectedDone, body.tag), true);
    return new Response(null, { status: 204 });
  }
  if (parsed.pathname === '/v1/manifests') return Response.json({ manifests: [] });
  if (parsed.pathname === '/v1/machine/me') {
    if (options.method === 'PATCH') return Response.json({});
    return Response.json({ machine: { name: 'PTY Mac', projectLabels: 'hidden' }, devices: [] });
  }
  throw new Error(`Unexpected fixture route ${options.method} ${parsed.pathname}`);
};
