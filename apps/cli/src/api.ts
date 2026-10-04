import { PROJECT_LABELS_HEADER } from '@greatping/protocol';
import { type Config, requireServer } from './config';
import { rememberProjectLabels } from './identity';
import { VERSION } from './version';

/** API failure with the server's error code when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  config: Config,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  requireServer(config);
  const token = options.token === undefined ? config.machineToken : options.token;
  // The version lets the server turn away a client it no longer supports with a clear message.
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-greatping-client': `cli/${VERSION}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    // A redirect must not change the destination of a request or its credential.
    const init: RequestInit = { method, headers, redirect: 'error' };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    response = await fetch(`${config.apiUrl}/v1${path}`, init);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof Error && error.name === 'TimeoutError') throw error;
    throw new ApiError(0, 'network', 'Could not reach GreatPing.');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = payload?.error?.code ?? 'http_error';
    throw new ApiError(
      response.status,
      code,
      describe(response.status, code, payload?.error?.message),
    );
  }
  // The service reports the computer's project-label mode with each alert, so
  // a change made on a device applies from the next alert on.
  const mode = response.headers.get(PROJECT_LABELS_HEADER);
  if (mode === 'folder' || mode === 'hidden') rememberProjectLabels(mode);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function describe(status: number, code: string, message?: string): string {
  if (status === 401) return 'This computer is no longer paired with GreatPing.';
  if (status === 429) return 'Too many requests. Try again in a minute.';
  if (status >= 500) return 'GreatPing is having trouble right now. Try again shortly.';
  if (message) return message.charAt(0).toUpperCase() + message.slice(1);
  return `Request failed (${status} ${code}).`;
}
