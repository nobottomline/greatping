import type { PingRequest } from '@greatping/protocol';
import { ApiError, api } from './api';
import {
  type Config,
  loadConfig,
  type QuestionCancellation,
  samePairing,
  updateConfig,
} from './config';

// Recovery cannot consume the user's question timeout or extend native shutdown
// indefinitely. Initial cancellation costs at most .5s + 3s + .5s after creation;
// a later mutation retries one queued ID with a 1.5s network budget.
const LOCAL_WAIT_MS = 500;
const CANCEL_MS = 3000;
const RETRY_MS = 1500;
const MAX_PENDING = 128;

function withPending(current: Config, pending: QuestionCancellation[]): Config {
  const { pendingQuestionCancellations: _pending, ...saved } = current;
  return pending.length ? { ...saved, pendingQuestionCancellations: pending } : saved;
}

function forget(config: Config, intent: QuestionCancellation): void {
  updateConfig(
    config,
    (current) => {
      const pending = current.pendingQuestionCancellations ?? [];
      const kept = pending.filter(
        (item) => item.requestId !== intent.requestId || item.expiresAt !== intent.expiresAt,
      );
      return kept.length === pending.length ? undefined : withPending(current, kept);
    },
    LOCAL_WAIT_MS,
  );
}

/** A final state or absence is authoritative; a successful pending reply is not. */
async function cancelRemote(
  config: Config,
  intent: QuestionCancellation,
  signal: AbortSignal,
): Promise<void> {
  let result: PingRequest | undefined;
  try {
    result = await api<PingRequest | undefined>(
      config,
      'POST',
      `/requests/${encodeURIComponent(intent.requestId)}/cancel`,
      {
        signal,
        updateLocalSettings: false,
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
  // Older services can acknowledge withdrawal with HTTP 204.
  if (result === undefined) return;
  if (
    result.id !== intent.requestId ||
    !['answered', 'expired', 'cancelled', 'resolved'].includes(result.status)
  )
    throw new Error('Question withdrawal is still unconfirmed; recovery was retained.');
}

/** Persist the exact cancelled question before I/O, then clear only after acknowledgement. */
export async function withdrawQuestion(
  config: Config,
  request: Pick<PingRequest, 'id' | 'expiresAt'>,
): Promise<void> {
  const intent = { requestId: request.id, expiresAt: request.expiresAt };
  const errors: unknown[] = [];
  let recorded = false;
  try {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(intent.requestId) ||
      !Number.isSafeInteger(intent.expiresAt) ||
      intent.expiresAt <= 0
    )
      throw new Error('The question returned invalid cancellation recovery metadata.');
    updateConfig(
      config,
      (current) => {
        const pending = (current.pendingQuestionCancellations ?? []).filter(
          (item) => item.expiresAt > Date.now(),
        );
        if (pending.some((item) => item.requestId === intent.requestId)) return undefined;
        if (pending.length >= MAX_PENDING)
          throw new Error('Question cancellation recovery is full. Retry a mutating command.');
        return withPending(current, [...pending, intent]);
      },
      LOCAL_WAIT_MS,
    );
    recorded = true;
  } catch (error) {
    errors.push(error);
  }
  let confirmed = false;
  try {
    // Even if persisting failed (including a local pairing change), the original
    // credential can withdraw only its own exact question. Never use new keys.
    await cancelRemote(config, intent, AbortSignal.timeout(CANCEL_MS));
    confirmed = true;
  } catch (error) {
    errors.push(error);
  }
  if (confirmed) {
    try {
      forget(config, intent);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      confirmed
        ? 'Question withdrawal was accepted, but local cancellation recovery could not be saved. Retry a mutating command.'
        : recorded
          ? 'Question withdrawal could not be confirmed. Saved cancellation recovery will retry on the next mutating command.'
          : 'Question withdrawal could not be confirmed and cancellation recovery could not be saved. Check GreatPing and retry.',
    );
}

/** Only queued cancellation intents are retried; active questions are never enumerated. */
export async function reconcileQuestionCancellations(
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const current = loadConfig();
  if (!samePairing(config, current))
    throw new Error('Local pairing changed. Retry the command with the current pairing.');
  if (!current.pendingQuestionCancellations?.length) return;
  let intent: QuestionCancellation | undefined;
  let localError: unknown;
  try {
    updateConfig(
      config,
      (saved) => {
        const pending = saved.pendingQuestionCancellations ?? [];
        const active = pending.filter((item) => item.expiresAt > Date.now());
        intent = active[0];
        // Failed IDs move to the back so one unavailable request cannot starve others.
        const rotated = intent ? [...active.slice(1), intent] : active;
        if (active.length === pending.length && active.length <= 1) return undefined;
        return withPending(saved, rotated);
      },
      LOCAL_WAIT_MS,
    );
  } catch (error) {
    if (!samePairing(config, loadConfig())) throw error;
    localError = error;
    intent = current.pendingQuestionCancellations.find((item) => item.expiresAt > Date.now());
  }
  if (intent) {
    const timeout = AbortSignal.timeout(RETRY_MS);
    try {
      await cancelRemote(config, intent, signal ? AbortSignal.any([signal, timeout]) : timeout);
      forget(config, intent);
    } catch (error) {
      signal?.throwIfAborted();
      // Provider/network failures retain the intent without blocking a fresh
      // mutation. Local write failures must remain visible to the user.
      if (
        !(error instanceof ApiError) &&
        !(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      )
        throw error;
    }
  }
  if (localError) throw localError;
}
