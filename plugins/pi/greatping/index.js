import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { events, mcp } from './native.mjs';

export default async function GreatPing(pi) {
  const queue = events('pi');
  let previous;
  let activePrompt;
  let failed = true;
  let running = false;
  const send = (ctx, name, correlation, reason) =>
    queue.send({
      hook_event_name: name,
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      correlation,
      reason,
    });
  pi.on('session_start', (_event, ctx) => {
    previous = ctx.sessionManager.getSessionId();
  });
  pi.on('session_switch', (_event, ctx) => {
    if (previous) queue.send({ hook_event_name: 'SessionEnd', session_id: previous });
    previous = ctx.sessionManager.getSessionId();
    activePrompt = undefined;
    failed = true;
    running = false;
  });
  pi.on('agent_start', (_event, ctx) => {
    failed = true;
    running = true;
    send(ctx, 'Started');
  });
  pi.on('message_end', (event) => {
    if (event.message.role === 'assistant')
      // Only a terminal successful response counts as completion. Aborting
      // before a response or between tool calls must not look like success.
      failed = event.message.stopReason !== 'stop';
  });
  pi.on('agent_settled', (_event, ctx) => {
    running = false;
    if (!activePrompt) send(ctx, failed ? 'SessionEnd' : 'Finished');
  });
  pi.on('ui_prompt_start', (_event, ctx) => {
    activePrompt = `ui:${randomUUID()}`;
    send(ctx, 'PromptOpen', activePrompt, 'input');
  });
  pi.on('ui_prompt_end', (_event, ctx) => {
    if (activePrompt) send(ctx, 'PromptClose', activePrompt);
    activePrompt = undefined;
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (running || activePrompt) send(ctx, 'SessionEnd');
    await queue.close();
  });
  // Use the runtime's actual MCP schemas rather than maintain a second set.
  // An unconfigured extension still loads safely; setup takes effect on reload.
  try {
    const { tools } = await mcp('pi', 'tools/list', {});
    for (const tool of tools)
      pi.registerTool({
        name: `greatping_${tool.name}`,
        label: `GreatPing ${tool.name}`,
        description: tool.description,
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(_id, args, signal, _update, ctx) {
          const result = await mcp(
            'pi',
            'tools/call',
            { name: tool.name, arguments: args },
            { signal, cwd: ctx.cwd },
          );
          if (result.isError)
            throw new Error(
              result.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('\n') || 'GreatPing operation failed.',
            );
          return {
            content: result.content,
            details: result.structuredContent ?? {},
          };
        },
      });
  } catch {
    /* Pairing and repair remain explicit CLI operations. */
  }
}
