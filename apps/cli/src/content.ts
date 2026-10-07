import type { Answer, Envelope, ProjectCommandsResponse } from '@greatping/protocol';
import {
  EnvelopeError,
  type EnvelopeMeta,
  type EnvelopePayload,
  fromBase64Url,
  type Manifest,
  openEnvelope,
  recipientsFor,
  type SecretKeys,
  sealEnvelope,
} from '@greatping/protocol/crypto';
import { api } from './api';
import { UsageError } from './commands/usage';
import { type Config, loadConfig } from './config';
import { applyProjectCommand, recentProjects } from './identity';
import { claimStamp } from './integrations/state';
import { followManifest, randomBytes } from './keys';

/**
 * End-to-end content on the computer (docs/e2e-encryption.md): what it sends
 * is sealed to the devices of its verified manifest and signed with its key;
 * what it receives is accepted only if a device of that manifest signed it.
 * Nothing falls back to plaintext.
 */

/** Hooks follow the manifest at most this often; explicit commands always do. */
const HOOK_MANIFEST_INTERVAL_MS = 5 * 60 * 1000;

const REPAIR = 'Run greatping logout, then greatping login to pair this computer again.';

function secrets(config: Config): SecretKeys {
  if (!config.keys)
    throw new UsageError(null, 'This computer has no keys for encrypted alerts.', REPAIR);
  return { sign: fromBase64Url(config.keys.sign), enc: fromBase64Url(config.keys.enc) };
}

/**
 * The newest manifest this computer verified. Explicit commands follow it on
 * every call, so a removed device never receives their content; hooks, which
 * carry at most a project label, follow it every few minutes.
 */
async function manifestFor(config: Config, fresh: boolean): Promise<Manifest> {
  if (!config.manifest)
    throw new UsageError(null, 'This computer was paired before end-to-end encryption.', REPAIR);
  if (fresh || claimStamp('manifest', HOOK_MANIFEST_INTERVAL_MS)) {
    const state = await followManifest(config);
    if (state.status === 'removed')
      throw new UsageError(null, 'This computer was removed from your GreatPing account.', REPAIR);
    if (state.status === 'invalid')
      throw new UsageError(
        null,
        'The account history could not be verified, so nothing was sent.',
        `${REPAIR} If this repeats, contact support.`,
      );
  }
  return loadConfig().manifest ?? config.manifest;
}

const accountOf = (manifest: Manifest) => manifest.account;

/** Seals a request's content to every device of the account. */
export async function sealRequest(
  config: Config,
  meta: EnvelopeMeta['request'],
  payload: EnvelopePayload['request'],
  options: { fresh: boolean },
): Promise<Envelope> {
  const manifest = await manifestFor(config, options.fresh);
  return sealEnvelope({
    purpose: 'request',
    accountId: accountOf(manifest),
    sender: { id: config.machineId as string, secret: secrets(config) },
    manifest,
    recipients: recipientsFor('request', manifest),
    meta,
    payload,
    now: Date.now(),
    random: randomBytes,
  });
}

/** Thrown when an answer does not verify; the question is withdrawn. */
export class UnverifiedAnswerError extends Error {
  constructor(readonly reason: string) {
    super('The answer could not be verified, so it was not accepted.');
  }
}

/**
 * Opens an answer to this computer's question: sealed by a device of the
 * account, for this very question, and one of the choices or allowed text.
 */
export async function verifyAnswer(
  config: Config,
  question: { envelope: Envelope; choices: string[]; allowText: boolean },
  answerEnvelope: Envelope | null,
): Promise<Answer> {
  if (!answerEnvelope) throw new UnverifiedAnswerError('missing');
  let manifest = loadConfig().manifest ?? config.manifest;
  if (!manifest) throw new UnverifiedAnswerError('no_manifest');
  // An answer from a device linked after the question needs the newer manifest.
  if (answerEnvelope.manifest > manifest.version) manifest = await manifestFor(config, true);
  let answer: EnvelopePayload['answer'];
  try {
    answer = openEnvelope({
      envelope: answerEnvelope,
      accountId: accountOf(manifest),
      me: { id: config.machineId as string, encSecrets: [secrets(config).enc] },
      manifest,
      expect: { purpose: 'answer', meta: { kind: 'ask' }, ref: question.envelope.id },
    }).payload;
  } catch (error) {
    throw new UnverifiedAnswerError(error instanceof EnvelopeError ? error.code : 'invalid');
  }
  if (answer.choice !== undefined && !question.choices.includes(answer.choice))
    throw new UnverifiedAnswerError('not_a_choice');
  if (answer.text !== undefined && !question.allowText) throw new UnverifiedAnswerError('no_text');
  return answer.choice !== undefined ? { choice: answer.choice } : { text: answer.text as string };
}

/** The `projects` envelope of this computer's recent projects, for its report. */
export async function sealProjects(config: Config): Promise<Envelope | null> {
  const projects = recentProjects();
  const manifest = await manifestFor(config, true);
  return sealEnvelope({
    purpose: 'projects',
    accountId: accountOf(manifest),
    sender: { id: config.machineId as string, secret: secrets(config) },
    manifest,
    recipients: recipientsFor('projects', manifest),
    meta: {},
    payload: { projects },
    now: Date.now(),
    random: randomBytes,
  });
}

/**
 * Takes the project commands devices queued for this computer and applies
 * those a device of the account signed. Returns how many were applied.
 */
export async function syncProjectCommands(config: Config, signal?: AbortSignal): Promise<number> {
  const { commands } = await api<ProjectCommandsResponse>(
    config,
    'POST',
    '/machine/me/project-commands/take',
    { signal: signal ?? AbortSignal.timeout(3000) },
  );
  if (commands.length === 0) return 0;
  const manifest = await manifestFor(config, true);
  let applied = 0;
  for (const envelope of commands) {
    try {
      const opened = openEnvelope({
        envelope,
        accountId: accountOf(manifest),
        me: { id: config.machineId as string, encSecrets: [secrets(config).enc] },
        manifest,
        expect: { purpose: 'project' },
      });
      if (applyProjectCommand(opened.envelope.meta.projectKey as string, opened.payload)) applied++;
    } catch {
      // Not from a device of the account, or for a project unknown here: ignored.
    }
  }
  return applied;
}
