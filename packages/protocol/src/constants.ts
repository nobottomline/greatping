/**
 * Constants shared by the wire schemas and the crypto module, kept apart so
 * `crypto/` can use them without importing the schemas that import it.
 */

export const LIMITS = {
  pairingTtlSec: 15 * 60,
  linkTtlSec: 10 * 60,
  timeoutDefaultSec: 30 * 60,
  attentionTimeoutSec: 7 * 24 * 3600,
  ackTimeoutDefaultSec: 90,
  reminderAfterSec: 5 * 60,
  bodyMaxLength: 1000,
  choicesMax: 8,
  choiceMaxLength: 80,
  answerTextMaxLength: 2000,
  /** A device younger than this may only remove devices and computers added after it. */
  removalCoolingOffSec: 72 * 3600,
  /** Members of one account's manifest; far above any personal setup. */
  manifestMembersMax: 100,
  escalationWaitDefaultSec: 90,
  escalationWaitMaxSec: 3600,
  reminderDefaultSec: 5 * 60,
  reminderMaxSec: 6 * 3600,
  eventRetentionDays: 90,
  /** A finished request keeps its text and answer this long, then only its outcome remains. */
  historyRetentionDays: 7,
  /** While the user is at the computer, an attention alert waits this long before it is sent. */
  presenceDelayDefaultSec: 30,
  presenceDelayMaxSec: 600,
  /** Longest pause of a computer's alerts. */
  pauseMaxSec: 7 * 24 * 3600,
  projectLabelMaxLength: 60,
} as const;

export const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * The agent or tool an alert comes from. Adapters map their host to one of
 * these; anything else is `other`. `cli` is the GreatPing command itself.
 */
export const ALERT_HOSTS = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'pi',
  'gemini-cli',
  'cli',
  'other',
] as const;
export type AlertHost = (typeof ALERT_HOSTS)[number];

/**
 * Why a native host needs the user. permission, question and input block the
 * agent until the user acts at the computer; finished and error mean it stopped
 * and waits for the next message.
 */
export const ATTENTION_REASONS = ['permission', 'question', 'input', 'finished', 'error'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];
