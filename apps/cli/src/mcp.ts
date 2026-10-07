import process from 'node:process';
import { LIMITS } from '@greatping/protocol';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { ApiError } from './api';
import {
  askQuestion,
  changePause,
  getAgentStatus,
  hostFromClientName,
  type Origin,
  sendNotice,
} from './operations';
import { VERSION } from './version';

const errorSchema = z.object({ status: z.literal('error'), code: z.string(), message: z.string() });
function failure(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'GreatPing could not complete the operation.';
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: {
      status: 'error' as const,
      code: error instanceof ApiError ? error.code : 'operation_failed',
      message,
    },
    isError: true,
  };
}
function result<T extends Record<string, unknown>>(value: T, text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}
const mutating = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'greatping', version: VERSION },
    {
      instructions:
        'GreatPing sends phone alerts and separate phone questions. Native host questions and approvals stay in the host. Installed hooks already alert for native prompts; do not duplicate those alerts. Use notify for requested outcome alerts, or a generic native-prompt alert only when automatic hooks are unavailable. Use ask_user only when the user explicitly wants to answer a separate GreatPing question on a device. Pause or resume alerts only at the user’s request. Never include secrets, credentials, private file contents or code in messages. Installation, pairing, repair and removal are managed through the CLI.',
    },
  );
  /** The agent this server runs for, from the name its MCP client reports. */
  const origin = (): Origin => ({
    host: hostFromClientName(server.server.getClientVersion()?.name),
    cwd: process.cwd(),
  });
  server.registerTool(
    'notify',
    {
      description:
        'Send a requested alert to the paired devices. Success means GreatPing queued the notification; it does not confirm device delivery. Omit message for a generic attention alert. Does not answer or approve native host prompts. Do not duplicate installed automatic hooks.',
      inputSchema: z.object({
        message: z.string().trim().min(1).max(LIMITS.bodyMaxLength).optional(),
        title: z.string().trim().min(1).max(100).optional(),
      }),
      outputSchema: z.union([
        z.object({ requestId: z.string(), status: z.enum(['accepted', 'paused']) }),
        errorSchema,
      ]),
      annotations: mutating,
    },
    async ({ message, title }, ctx) => {
      try {
        const value = await sendNotice(
          message ?? 'Agent needs your attention. Please return to your computer.',
          title,
          ctx.mcpReq.signal,
          origin(),
        );
        return result(
          { ...value },
          value.status === 'paused'
            ? 'The notice is in the app, but alerts from this computer are paused.'
            : 'Notification queued.',
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'ask_user',
    {
      description:
        'Ask a separate GreatPing question on paired devices and wait for its answer. Use only when the user explicitly wants a phone question. Does not answer native host questions or approvals.',
      inputSchema: z.object({
        question: z.string().trim().min(1).max(LIMITS.bodyMaxLength),
        choices: z
          .array(z.string().trim().min(1).max(LIMITS.choiceMaxLength))
          .max(LIMITS.choicesMax)
          .optional(),
        allowText: z
          .boolean()
          .default(true)
          .describe(
            'With choices, whether the user may also answer in their own words. Set false only when the answer must be one of the choices.',
          ),
        timeoutSeconds: z.number().int().min(10).max(86400).default(LIMITS.timeoutDefaultSec),
      }),
      outputSchema: z.union([
        z.object({
          requestId: z.string(),
          status: z.enum(['answered', 'expired', 'cancelled', 'resolved']),
          paused: z.boolean(),
          answer: z
            .object({ choice: z.string().optional(), text: z.string().optional() })
            .optional(),
        }),
        errorSchema,
      ]),
      annotations: mutating,
    },
    async ({ question, choices, allowText, timeoutSeconds }, ctx) => {
      try {
        const value = await askQuestion(question, choices ?? [], timeoutSeconds, {
          allowText,
          signal: ctx.mcpReq.signal,
          origin: origin(),
        });
        return result(
          { ...value },
          value.answer?.choice ?? value.answer?.text ?? `The question was ${value.status}.`,
          value.status !== 'answered',
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'get_status',
    {
      description:
        'Read this computer’s GreatPing pairing, connection, pause, device count and agent integrations. Does not send alerts or update settings. Unreachable means the live pause and device count are unknown.',
      inputSchema: z.object({}),
      outputSchema: z.union([
        z.object({
          paired: z.boolean(),
          connection: z.enum(['unpaired', 'connected', 'revoked', 'unreachable']),
          pairingProblem: z.enum(['unpaired', 'environment_mismatch']).nullable(),
          alertsPausedUntil: z.number().nullable(),
          deviceCount: z.number().nullable(),
          integrations: z.array(
            z.object({
              id: z.string(),
              hooks: z.enum(['ok', 'broken', 'off']),
              finished: z.boolean(),
              mcp: z.boolean(),
              skill: z.boolean(),
              lastHookAt: z.number().nullable(),
            }),
          ),
          plugins: z.array(
            z.object({
              id: z.enum(['claude', 'codex', 'opencode', 'pi', 'cursor']),
              status: z.enum(['absent', 'disabled', 'unconfigured', 'ready', 'broken', 'unknown']),
              version: z.string().nullable(),
              finished: z.boolean(),
              alerts: z.array(z.string()),
              problem: z.string().nullable(),
              conflicts: z.array(z.string()),
              hookTrust: z.literal('host-managed'),
              lastAlert: z
                .object({
                  at: z.number(),
                  outcome: z.enum(['accepted', 'failed']),
                  problem: z
                    .enum([
                      'unpaired',
                      'environment_mismatch',
                      'revoked',
                      'network',
                      'timeout',
                      'rate_limited',
                      'service',
                      'rejected',
                      'local',
                    ])
                    .nullable(),
                })
                .nullable(),
            }),
          ),
        }),
        errorSchema,
      ]),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (_args, ctx) => {
      try {
        const value = await getAgentStatus(ctx.mcpReq.signal);
        return result({ ...value }, `GreatPing connection: ${value.connection}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'pause_alerts',
    {
      description:
        'At the user’s request, pause this computer’s alerts on all paired devices. Requests remain in the inbox. Defaults to one hour; maximum seven days.',
      inputSchema: z.object({
        durationSeconds: z.number().int().min(60).max(LIMITS.pauseMaxSec).default(3600),
      }),
      outputSchema: z.union([z.object({ alertsPausedUntil: z.number().nullable() }), errorSchema]),
      annotations: mutating,
    },
    async ({ durationSeconds }, ctx) => {
      try {
        const value = await changePause(durationSeconds, ctx.mcpReq.signal);
        return result({ ...value }, 'Alerts from this computer are paused.');
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'resume_alerts',
    {
      description: 'At the user’s request, resume this computer’s alerts on all paired devices.',
      inputSchema: z.object({}),
      outputSchema: z.union([z.object({ alertsPausedUntil: z.number().nullable() }), errorSchema]),
      annotations: { ...mutating, idempotentHint: true },
    },
    async (_args, ctx) => {
      try {
        const value = await changePause(null, ctx.mcpReq.signal);
        return result({ ...value }, 'Alerts from this computer are enabled.');
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

export function startMcp(): void {
  void serveStdio(createMcpServer);
}
