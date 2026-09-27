import { spawn } from 'node:child_process';
import process from 'node:process';
import { LIMITS } from '@greatping/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { VERSION } from './version';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], signal: AbortSignal): Promise<CommandResult> {
  if (signal.aborted) return Promise.reject(new Error('Request cancelled.'));
  const cliPath = process.argv[1];
  if (!cliPath) return Promise.reject(new Error('GreatPing executable path is unavailable.'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onAbort = () => child.kill('SIGINT');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-65536);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-65536);
    });

    const finish = (result?: CommandResult, error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    child.once('error', (error) => finish(undefined, error));
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function startMcp(): void {
  void serveStdio(() => {
    const server = new McpServer(
      { name: 'greatping', version: VERSION },
      {
        instructions:
          'Prefer your host’s native question and approval prompts. Before opening a native prompt that needs the user at the computer, call notify with no message to send a generic alert, then use the native prompt. GreatPing cannot answer or approve that native prompt. Use ask_user only when the user explicitly wants to answer a GreatPing question from a device. Do not copy native prompts, commands, secrets, or choices into notify.',
      },
    );

    server.registerTool(
      'ask_user',
      {
        description:
          'Ask a separate GreatPing question on the paired devices and wait for its answer. This does not answer a native host question or approval. Use only when an answer from a device is explicitly wanted.',
        inputSchema: z.object({
          question: z.string().trim().min(1).max(LIMITS.bodyMaxLength),
          choices: z
            .array(
              z
                .string()
                .trim()
                .min(1)
                .max(LIMITS.choiceMaxLength)
                .refine((s) => !s.includes(',')),
            )
            .max(LIMITS.choicesMax)
            .optional()
            .describe('Optional choices. Omit for a free-form answer.'),
          timeoutSeconds: z.number().int().min(10).max(86400).default(LIMITS.timeoutDefaultSec),
        }),
      },
      async ({ question, choices, timeoutSeconds }, ctx) => {
        const args = ['ask', question, '--timeout', String(timeoutSeconds), '--json'];
        if (choices?.length) args.push('--choices', choices.join(','));
        try {
          const result = await runCli(args, ctx.mcpReq.signal);
          if (result.code !== 0) {
            return failure(
              result.code === 2
                ? 'The question expired without an answer.'
                : result.stderr.trim() || 'Could not get an answer.',
            );
          }
          const parsed = JSON.parse(result.stdout) as {
            requestId: string;
            answer: { choice?: string; text?: string };
          };
          const answer = parsed.answer.choice ?? parsed.answer.text;
          if (!answer) return failure('The device returned an empty answer.');
          return {
            content: [{ type: 'text' as const, text: answer }],
            structuredContent: { requestId: parsed.requestId, answer: parsed.answer },
          };
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'Could not get an answer.');
        }
      },
    );

    server.registerTool(
      'notify',
      {
        description:
          'Ping the paired devices before a native question or approval. Omit message for a generic attention alert. This does not answer, approve, or resume the native prompt.',
        inputSchema: z.object({
          message: z.string().trim().min(1).max(LIMITS.bodyMaxLength).optional(),
        }),
      },
      async ({ message }, ctx) => {
        try {
          const result = await runCli(
            ['notify', message ?? 'Agent needs your attention. Please return to your computer.'],
            ctx.mcpReq.signal,
          );
          if (result.code !== 0)
            return failure(result.stderr.trim() || 'Could not send the notice.');
          const text = /paused/i.test(result.stderr)
            ? 'Alerts from this computer are paused: the notice is listed in the app, but no device was alerted.'
            : 'Notification sent.';
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'Could not send the notice.');
        }
      },
    );

    return server;
  });
}
