import type { Config } from './config';

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

export function host(config: Config): string {
  try {
    return new URL(config.apiUrl).host;
  } catch {
    return config.apiUrl;
  }
}

export async function api<T>(
  config: Config,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const token = options.token === undefined ? config.machineToken : options.token;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    response = await fetch(`${config.apiUrl}/v1${path}`, init);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof Error && error.name === 'TimeoutError') throw error;
    throw new ApiError(0, 'network', `Could not reach GreatPing at ${host(config)}.`);
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
