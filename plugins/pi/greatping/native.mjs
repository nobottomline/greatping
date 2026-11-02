// Native adapters send only normalized lifecycle metadata to the installed CLI.
// The serial, bounded queue keeps closing events behind opening events without
// awaiting network delivery in host callbacks. No credentials or prompt text.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnvironment, readSettings } from './bridge.mjs';

export function events(host) {
  let tail = Promise.resolve();
  let pending = 0;
  let stopped = false;
  const children = new Set();
  return {
    send(input) {
      if (stopped || pending >= 128) return;
      pending++;
      tail = tail
        .then(async () => {
          if (stopped) return;
          let settings;
          try {
            settings = readSettings(host);
          } catch {
            return;
          }
          if (!settings || (process.env.GREATPING_DISABLE && process.env.GREATPING_DISABLE !== '0'))
            return;
          await new Promise((done) => {
            const child = spawn(
              settings.launcher.command,
              [
                ...settings.launcher.args,
                'hook',
                host,
                ...(settings.finished ? ['--finished'] : []),
              ],
              {
                stdio: ['pipe', 'ignore', 'ignore'],
                env: childEnvironment(settings.launcher),
              },
            );
            children.add(child);
            const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
            const finish = () => {
              clearTimeout(timer);
              children.delete(child);
              done();
            };
            child.once('error', finish);
            child.once('close', finish);
            child.stdin.on('error', () => {});
            child.stdin.end(JSON.stringify(input));
          });
        })
        .catch(() => {})
        .finally(() => {
          pending--;
        });
    },
    async close() {
      // Host shutdown has a fixed budget, including a hung network/runtime.
      let timer;
      await Promise.race([
        tail,
        new Promise((done) => {
          timer = setTimeout(done, 8500);
        }),
      ]);
      clearTimeout(timer);
      stopped = true;
      for (const child of children) child.kill('SIGKILL');
    },
  };
}

// A short-lived local MCP connection uses the CLI's authoritative schemas and
// operations. No second transport, pairing store or native-host dependency.
export async function mcp(host, method, params, { signal, cwd } = {}) {
  signal?.throwIfAborted();
  const settings = readSettings(host);
  if (!settings) throw new Error(`Configure GreatPing with greatping setup ${host}.`);
  const child = spawn(settings.launcher.command, [...settings.launcher.args, 'mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: childEnvironment(settings.launcher),
  });
  const lines = createInterface({ input: child.stdout });
  let next = 0;
  const waiting = new Map();
  let failure;
  let cancellationTimer;
  let cancellationBudget = 25000;
  let cancelled = false;
  const cancelledIds = new Set();
  const cancellationError = (confirmed = false) =>
    new Error(
      confirmed
        ? 'GreatPing local runtime request was cancelled.'
        : 'GreatPing local runtime request was cancelled, but question withdrawal could not be confirmed. Check GreatPing.',
    );
  const fail = (error = new Error('GreatPing local runtime closed.')) => {
    failure = cancelled ? cancellationError() : error;
    for (const item of waiting.values()) item.reject(failure);
    waiting.clear();
  };
  child.on('error', () => fail());
  child.on('close', () => fail());
  child.stdin.on('error', () => fail());
  const stop = () => {
    child.kill('SIGKILL');
    fail();
  };
  const abort = () => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(deadline);
    for (const [requestId, item] of waiting) {
      // Initialization cannot have created a phone question.
      if (item.method !== 'tools/call' || params?.name !== 'ask_user') {
        item.reject(cancellationError(true));
        waiting.delete(requestId);
        continue;
      }
      cancelledIds.add(requestId);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId },
        })}\n`,
      );
    }
    // The new runtime acknowledges actual cleanup. Older runtimes receive the
    // standard cancellation too; the fallback bounds recovery and reports that
    // withdrawal is unconfirmed. 25s covers creation (8s), queued project sync
    // (6s), config contention (5s), withdrawal (3s), bounded recovery writes
    // (1s total), and runtime scheduling.
    cancellationTimer = setTimeout(stop, cancellationBudget);
  };
  const deadline = setTimeout(
    abort,
    method === 'tools/call' && params?.name === 'ask_user'
      ? ((params.arguments?.timeoutSeconds ?? 1800) + 15) * 1000
      : 10000,
  );
  signal?.addEventListener('abort', abort, { once: true });
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      if (response.method === 'notifications/greatping/cancellation') {
        const requestId = response.params?.requestId;
        if (!cancelledIds.has(requestId)) return;
        const item = waiting.get(requestId);
        waiting.delete(requestId);
        item?.reject(cancellationError(response.params.confirmed === true));
        return;
      }
      const item = waiting.get(response.id);
      if (!item) return;
      waiting.delete(response.id);
      if (cancelled)
        item.reject(
          cancellationError(
            ['cancelled', 'answered', 'expired', 'resolved'].includes(
              response.result?.structuredContent?.status,
            ),
          ),
        );
      else if (response.error) item.reject(new Error('GreatPing rejected the local tool request.'));
      else item.resolve(response.result);
    } catch {
      fail();
    }
  });
  const request = (name, value) =>
    new Promise((resolve, reject) => {
      if (failure || cancelled) {
        reject(failure ?? cancellationError(true));
        return;
      }
      const id = ++next;
      waiting.set(id, { resolve, reject, method: name });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: name, params: value })}\n`);
    });
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: host, version: '0.1.0' },
    });
    const advertised = initialized?.capabilities?.experimental?.['greatping/cancellation'];
    if (
      advertised?.version === 1 &&
      Number.isInteger(advertised.timeoutMs) &&
      advertised.timeoutMs > 0 &&
      advertised.timeoutMs <= cancellationBudget
    )
      cancellationBudget = advertised.timeoutMs;
    signal?.throwIfAborted();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const value =
      method === 'tools/call' && params?.name === 'ask_user'
        ? { ...params, _meta: { ...params._meta, 'greatping/cancellation': 1 } }
        : params;
    return await request(method, value);
  } finally {
    clearTimeout(deadline);
    clearTimeout(cancellationTimer);
    signal?.removeEventListener('abort', abort);
    lines.close();
    child.kill('SIGKILL');
  }
}
