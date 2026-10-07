import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './bridge.mjs';
import { events } from './native.mjs';

// OpenCode 1.x's server plugin API forwards event data as `properties`.
async function GreatPing({ directory, client }) {
  const queue = events('opencode');
  const active = new Set();
  const errored = new Set();
  const parents = new Map();
  const generation = new Map();
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    async config(config) {
      // Merge the effective config, never rewrite user JSON/JSONC or replace an
      // existing server. The skill documents the duplicate-registration case.
      let settings;
      try {
        settings = readSettings('opencode');
      } catch {
        return;
      }
      if (!settings) return;
      config.mcp ??= {};
      config.mcp.greatping ??= {
        type: 'local',
        command: [settings.launcher.command, ...settings.launcher.args, 'mcp'],
        enabled: true,
      };
      config.skills ??= {};
      config.skills.paths = [...(config.skills.paths ?? []), join(here, 'skills')];
    },
    async event({ event }) {
      const p = event.properties ?? {};
      if (event.type === 'session.created' || event.type === 'session.updated') {
        if (p.info?.id) parents.set(p.info.id, Boolean(p.info.parentID));
        return;
      }
      const session = p.sessionID ?? (event.type === 'session.deleted' ? p.info?.id : undefined);
      if (typeof session !== 'string') return;
      const send = (name, correlation, reason) =>
        queue.send({
          hook_event_name: name,
          session_id: session,
          cwd: directory,
          correlation,
          reason,
        });
      switch (event.type) {
        case 'permission.asked':
        case 'question.asked':
          if (typeof p.id === 'string')
            send(
              'PromptOpen',
              `${event.type}:${p.id}`,
              event.type === 'permission.asked' ? 'permission' : 'question',
            );
          break;
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected':
          if (typeof p.requestID === 'string')
            send(
              'PromptClose',
              `${event.type.startsWith('permission') ? 'permission' : 'question'}.asked:${p.requestID}`,
            );
          break;
        case 'session.status':
          if (p.status?.type === 'busy' || p.status?.type === 'retry') {
            if (!active.has(session)) {
              active.add(session);
              generation.set(session, (generation.get(session) ?? 0) + 1);
              errored.delete(session);
              send('Started');
            }
          }
          // `session.idle` also fires, so consume only one completion signal.
          break;
        case 'session.error':
          errored.add(session);
          send('SessionEnd');
          break;
        case 'session.deleted':
          active.delete(session);
          generation.delete(session);
          parents.delete(session);
          errored.delete(session);
          send('SessionEnd');
          break;
        case 'session.idle': {
          if (!active.delete(session)) return;
          const turn = generation.get(session);
          if (errored.delete(session)) {
            send('SessionEnd');
            return;
          }
          // Existing sessions may predate plugin startup. Never report a child
          // agent as the user's finished response; unknown sessions fail closed.
          if (!parents.has(session)) {
            try {
              const info = await Promise.race([
                client.session.get({ path: { id: session } }),
                new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
              ]);
              if (info?.data) parents.set(session, Boolean(info.data.parentID));
            } catch {
              /* No completion alert without session identity. */
            }
          }
          if (
            parents.get(session) === false &&
            !active.has(session) &&
            !errored.has(session) &&
            generation.get(session) === turn
          )
            send('Finished');
          break;
        }
      }
    },
    dispose: () => queue.close(),
  };
}

export default { id: 'greatping', server: GreatPing };
