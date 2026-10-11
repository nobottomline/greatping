// The setup preview may only read settings. Any write request fails this probe.
import { appendFileSync } from 'node:fs';
import {
  PROJECT_COMMANDS_HEADER,
  PROJECT_LABELS_HEADER,
  SERVICE_ORIGIN,
} from '@greatping/protocol';

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method ?? 'GET';
  if (parsed.origin !== SERVICE_ORIGIN || parsed.pathname !== '/v1/machine/me' || method !== 'GET')
    throw new Error('Setup preview attempted an unexpected request.');
  appendFileSync(process.env.GREATPING_TEST_SETUP_LOG, `${method} ${parsed.pathname}\n`);
  return Response.json(
    { machine: { projectLabels: 'folder' } },
    {
      headers: { [PROJECT_LABELS_HEADER]: 'folder', [PROJECT_COMMANDS_HEADER]: '1' },
    },
  );
};
