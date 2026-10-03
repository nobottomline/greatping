import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://registry.npmjs.org') {
    if (parsed.pathname !== '/-/package/greatping/dist-tags') throw new Error('Unexpected npm URL');
    if (options.headers.authorization) throw new Error('Credentials sent to npm');
    if (process.env.GREATPING_TEST_LOG) appendFileSync(process.env.GREATPING_TEST_LOG, 'npm\n');
    if (process.env.GREATPING_TEST_NPM === 'hang') await new Promise(() => {});
    return Response.json({ latest: '99.0.0' });
  }
  if (parsed.origin !== 'https://greatping-api-dev.ueldo343.workers.dev')
    throw new Error('Unexpected hosted request');
  if (parsed.pathname === '/v1/requests' && options.method === 'POST')
    return Response.json({
      id: 'terminal-request',
      status: 'pending',
      expiresAt: Date.now() + 60000,
    });
  if (parsed.pathname === '/v1/requests/terminal-request/cancel')
    return new Response(null, { status: 204 });
  if (parsed.pathname === '/v1/requests/terminal-request') {
    await delay(700, undefined, { signal: options.signal });
    const mode = process.env.GREATPING_TEST_MODE || 'answered';
    if (mode === 'error')
      return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
    return Response.json({
      id: 'terminal-request',
      status: mode,
      ...(mode === 'answered' ? { answer: { text: 'Ship it' } } : {}),
    });
  }
  throw new Error(`Unexpected fixture route ${options.method} ${parsed.pathname}`);
};
