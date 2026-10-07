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
  const fail = () => {
    failure = new Error('GreatPing local runtime closed or was cancelled.');
    for (const item of waiting.values()) item.reject(failure);
    waiting.clear();
  };
  child.on('error', fail);
  child.on('close', fail);
  child.stdin.on('error', fail);
  const stop = () => {
    child.kill('SIGKILL');
    fail();
  };
  const abort = () => {
    // Give the CLI a chance to cancel a phone question before disconnecting.
    for (const requestId of waiting.keys())
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId },
        })}\n`,
      );
    fail();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(
    stop,
    method === 'tools/call' && params?.name === 'ask_user'
      ? ((params.arguments?.timeoutSeconds ?? 1800) + 15) * 1000
      : 10000,
  );
  lines.on('line', (line) => {
    try {
      const response = JSON.parse(line);
      const item = waiting.get(response.id);
      if (!item) return;
      waiting.delete(response.id);
      if (response.error) item.reject(new Error('GreatPing rejected the local tool request.'));
      else item.resolve(response.result);
    } catch {
      fail();
    }
  });
  const request = (name, value) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = ++next;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: name, params: value })}\n`);
    });
  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: host, version: '0.1.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    return await request(method, params);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) await new Promise((done) => setTimeout(done, 1000));
    lines.close();
    child.kill('SIGKILL');
  }
}
