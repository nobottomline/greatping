import { appendFileSync } from 'node:fs';

// This subprocess must never use the network, including on an unexpected route.
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  const allowed =
    target.origin === process.env.GREATPING_TEST_SERVICE &&
    ['/v1/requests', '/v1/requests/resolve'].includes(target.pathname) &&
    options.method === 'POST' &&
    options.redirect === 'error' &&
    new Headers(options.headers).get('authorization') === 'Bearer test-token';
  appendFileSync(
    process.env.GREATPING_TEST_RECORD,
    `${JSON.stringify({
      path: target.pathname,
      body: JSON.parse(options.body ?? 'null'),
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      unexpected: !allowed,
    })}\n`,
  );
  if (!allowed || process.env.GREATPING_TEST_FETCH_FAIL) {
    throw new Error('Isolated hook transport rejected the request');
  }
  return Response.json(
    target.pathname.endsWith('/resolve')
      ? { resolved: true }
      : { id: 'fixture-request', status: 'pending' },
  );
};
