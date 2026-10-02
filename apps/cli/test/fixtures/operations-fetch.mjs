import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.GREATPING_TEST_MODE ?? 'answered';
const log = process.env.GREATPING_TEST_LOG;
const paused = mode === 'paused';
let until = null;
if (mode === 'cleanup-fail') {
  const original = fs.rmSync;
  fs.rmSync = (path, options) => {
    if (String(path).endsWith('/setup-options.json')) throw new Error('Fixture permission error');
    return original(path, options);
  };
  syncBuiltinESMExports();
}

globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : null;
  if (log) appendFileSync(log, `${JSON.stringify({ path, method: init.method, body })}\n`);
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  if (mode === 'network') throw new Error('offline');
  if (mode === 'revoked') return json({ error: { code: 'unauthorized' } }, 401);
  if (path === '/v1/machine/me' && init.method === 'DELETE')
    return new Response(null, { status: 204 });
  if (path === '/v1/machine/me' && init.method === 'GET')
    return json({
      accountId: 'private-account',
      machine: { id: 'test-machine', name: 'PRIVATE MACHINE', alertsPausedUntil: until },
      devices: [{ name: 'PRIVATE PHONE', type: 'phone', mode: 'first' }],
    });
  if (path === '/v1/machine/me/pause') {
    until = body.until;
    return json({ alertsPausedUntil: until });
  }
  if (path === '/v1/requests' && init.method === 'POST') {
    if (mode === 'cancel') await new Promise((resolve) => setTimeout(resolve, 250));
    return json({ id: 'test-request', status: 'pending', expiresAt: Date.now() + 60000, paused });
  }
  if (path === '/v1/requests/test-request' && init.method === 'GET')
    return json({
      id: 'test-request',
      status: mode === 'expired' ? 'expired' : 'answered',
      answer: mode === 'expired' ? null : { choice: 'Yes' },
    });
  if (path === '/v1/requests/test-request/cancel') return new Response(null, { status: 204 });
  throw new Error(`Unexpected fixture route ${init.method} ${path}`);
};
