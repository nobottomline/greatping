import { z } from 'zod';

export const PROTOCOL_VERSION = '0.1.0';

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
  escalationWaitDefaultSec: 90,
  escalationWaitMaxSec: 3600,
  reminderDefaultSec: 5 * 60,
  reminderMaxSec: 6 * 3600,
  eventRetentionDays: 90,
  /** While the user is at the computer, an attention alert waits this long before it is sent. */
  presenceDelayDefaultSec: 30,
  presenceDelayMaxSec: 600,
  /** Longest pause of a computer's alerts. */
  pauseMaxSec: 7 * 24 * 3600,
} as const;

export const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type DevicePlatform = 'ios' | 'android';
export type DeviceType = 'phone' | 'tablet';
export type MachinePlatform = 'darwin' | 'linux' | 'win32' | 'other';

/** Coarse network location from the edge. Raw IP addresses are never stored. */
export interface Place {
  city: string | null;
  country: string | null;
  /** Network operator, e.g. "Comcast Cable" (ASN organisation). */
  network: string | null;
}

/** Which alerts a device wants, independent of the computer that sends them. */
export type AlertCategory = 'attention' | 'question' | 'notice';
export const ALERT_CATEGORIES: readonly AlertCategory[] = ['attention', 'question', 'notice'];

export type NotificationState = 'enabled' | 'denied' | 'unavailable' | 'unknown';

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  type: DeviceType;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  notifications: NotificationState;
  hasPushToken: boolean;
  appLock: boolean | null;
  alertCategories: AlertCategory[];
  breakThroughFocus: boolean;
  approvedByDeviceId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPlace: Place | null;
  /** When this device may remove devices and computers that joined before it. */
  seniorAt: number;
}

/**
 * An agent host on a computer as the CLI last saw it. The computer reports this
 * about itself; it is informational and grants nothing.
 */
export interface HostIntegration {
  /** "claude-code" or "codex". */
  id: string;
  /**
   * Automatic alerts from the host's hooks: `ok` when installed and pointing at a
   * working GreatPing, `broken` when installed but unable to run, `off` otherwise.
   */
  hooks: 'ok' | 'broken' | 'off';
  /** Hooks also alert when the agent finishes a turn and waits for the next message. */
  finished: boolean;
  /** GreatPing's MCP tools (ask_user, notify) are registered with the host. */
  mcp: boolean;
  /** The GreatPing skill is installed for the host. */
  skill: boolean;
  /** Last time one of the host's GreatPing hooks ran on the computer. */
  lastHookAt: number | null;
}

export interface Machine {
  id: string;
  name: string;
  platform: MachinePlatform;
  osVersion: string | null;
  arch: string | null;
  cliVersion: string | null;
  /** Host integrations installed on the computer, e.g. "claude-code". */
  integrations: string[];
  /** Per-host detail reported by newer CLIs; empty for older ones. */
  hosts: HostIntegration[];
  pairedByDeviceId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPlace: Place | null;
  /** Seconds before Standard devices are alerted; 0 alerts them immediately. */
  escalationWaitSec: number;
  /** Seconds after the escalation before a reminder; null turns reminders off. */
  reminderAfterSec: number | null;
  /** Seconds an attention alert waits while the user is at the computer; 0 sends it at once. */
  presenceDelaySec: number;
  /** Until when the computer's alerts are paused; null when they are not. */
  alertsPausedUntil: number | null;
  lastAlertAt: number | null;
  alertsLast7Days: number;
}

/**
 * How one computer reaches one device.
 * - first: alerted immediately
 * - standard: alerted after the computer's escalation wait (or immediately without a first device)
 * - backup: alerted only by the reminder
 * - off: never notified; the request still appears in the inbox
 */
export type RouteMode = 'first' | 'standard' | 'backup' | 'off';
export const ROUTE_MODES: readonly RouteMode[] = ['first', 'standard', 'backup', 'off'];

export interface Route {
  machineId: string;
  deviceId: string;
  mode: RouteMode;
}

export type AccountEventType =
  | 'account.created'
  | 'device.linked'
  | 'device.removed'
  | 'device.left'
  | 'machine.paired'
  | 'machine.removed'
  | 'machine.unpaired'
  | 'machine.renamed'
  | 'routing.changed';

/** Security activity: membership and routing changes, kept for 90 days. */
export interface AccountEvent {
  id: string;
  type: AccountEventType;
  actorDeviceId: string | null;
  actorMachineId: string | null;
  /** Name of the acting device or computer at the time of the event. */
  actorName: string | null;
  subjectId: string | null;
  subjectName: string | null;
  detail: string | null;
  place: Place | null;
  createdAt: number;
}

export interface Answer {
  choice?: string;
  text?: string;
}

export type RequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired' | 'resolved';
export type EscalationStage = 'primary' | 'all' | 'reminder' | 'done';

export interface PingRequest {
  id: string;
  accountId: string;
  machineId: string;
  machineName: string;
  kind: 'ask' | 'notify';
  /** attention: a native host prompt; question: an explicit GreatPing question; notice: a message. */
  category: AlertCategory;
  title: string | null;
  body: string;
  choices: string[];
  allowText: boolean;
  status: RequestStatus;
  stage: EscalationStage;
  answer: Answer | null;
  answeredByDeviceId: string | null;
  createdAt: number;
  expiresAt: number;
  ackedAt: number | null;
  answeredAt: number | null;
  /** Created while the computer's alerts were paused: listed, but no device was alerted. */
  paused?: boolean;
}

export type PushData =
  | {
      type: 'request';
      requestId: string;
      kind: 'ask' | 'notify';
      choices: string[];
      allowText: boolean;
      stage: EscalationStage;
    }
  | { type: 'resolved'; requestId: string; status: RequestStatus }
  /** Another device opened the request; its alert can be cleared here. */
  | { type: 'acked'; requestId: string }
  /** Security notice: the account's devices or computers changed. */
  | { type: 'security'; event: AccountEventType };

export type RequestEvent =
  | { type: 'state'; request: PingRequest }
  | { type: 'acked'; request: PingRequest }
  | { type: 'answered'; request: PingRequest }
  | { type: 'cancelled'; request: PingRequest }
  | { type: 'expired'; request: PingRequest }
  | { type: 'resolved'; request: PingRequest };

/** Account data a live event can make stale on a device. */
export type LiveTopic = 'me' | 'events' | 'requests';

/**
 * Sent over the account's live WebSocket (`GET /v1/live`) to every open app of
 * the account. Events are hints, not a log: an app that reconnects refetches
 * what it may have missed, so a lost event never leaves stale data behind.
 */
export type LiveEvent =
  /** A request changed; the snapshot replaces the cached one unless that is further along. */
  | { type: 'request'; request: PingRequest }
  /** Something else changed; the app refetches these topics. */
  | { type: 'changed'; topics: LiveTopic[] };

/** Close codes of the live WebSocket after which the app must not reconnect. */
export const LIVE_CLOSE = {
  /** The device was removed from the account. */
  revoked: 4001,
  /** A newer connection of the same device took over. */
  replaced: 4002,
} as const;

/** Heartbeat of the live WebSocket; the server answers without waking up. */
export const LIVE_PING = 'ping';
export const LIVE_PONG = 'pong';

// ---------------------------------------------------------------------------
// API schemas
// ---------------------------------------------------------------------------

const deviceDescriptionSchema = {
  name: z.string().trim().min(1).max(50),
  platform: z.enum(['ios', 'android']),
  type: z.enum(['phone', 'tablet']).optional(),
  model: z.string().max(80).optional(),
  osVersion: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
};

export const registerDeviceBodySchema = z.object({
  ...deviceDescriptionSchema,
  pushToken: z.string().optional(),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;

export interface RegisterDeviceResponse {
  accountId: string;
  deviceId: string;
  deviceToken: string;
}

/** A device updates only itself. */
export const updateDeviceBodySchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  pushToken: z.string().nullable().optional(),
  type: z.enum(['phone', 'tablet']).optional(),
  model: z.string().max(80).optional(),
  osVersion: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
  notifications: z.enum(['enabled', 'denied', 'unavailable', 'unknown']).optional(),
  appLock: z.boolean().optional(),
  alertCategories: z
    .array(z.enum(['attention', 'question', 'notice']))
    .max(3)
    .optional(),
  breakThroughFocus: z.boolean().optional(),
});
export type UpdateDeviceBody = z.infer<typeof updateDeviceBodySchema>;

export interface MeResponse {
  accountId: string;
  device: Device;
  devices: Device[];
  machines: Machine[];
  routes: Route[];
}

export interface ListEventsResponse {
  events: AccountEvent[];
}

/** Computer settings a device can change. */
export const updateMachineBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  escalationWaitSec: z.number().int().min(0).max(LIMITS.escalationWaitMaxSec).optional(),
  reminderAfterSec: z.number().int().min(60).max(LIMITS.reminderMaxSec).nullable().optional(),
  presenceDelaySec: z.number().int().min(0).max(LIMITS.presenceDelayMaxSec).optional(),
  /** A timestamp within the pause limit, or null to resume. */
  alertsPausedUntil: z.number().int().positive().nullable().optional(),
});
export type UpdateMachineBody = z.infer<typeof updateMachineBodySchema>;

export const updateRouteBodySchema = z.object({
  mode: z.enum(['first', 'standard', 'backup', 'off']),
});
export type UpdateRouteBody = z.infer<typeof updateRouteBodySchema>;

export interface UpdateRouteResponse {
  routes: Route[];
}

export const hostIntegrationSchema = z.object({
  id: z.string().min(1).max(40),
  hooks: z.enum(['ok', 'broken', 'off']),
  finished: z.boolean(),
  mcp: z.boolean(),
  skill: z.boolean(),
  lastHookAt: z.number().int().nonnegative().nullable(),
});

const machineDescriptionSchema = {
  osVersion: z.string().max(60).optional(),
  arch: z.string().max(20).optional(),
  cliVersion: z.string().max(40).optional(),
  integrations: z.array(z.string().max(40)).max(10).optional(),
  hosts: z.array(hostIntegrationSchema).max(10).optional(),
};

/** A computer reports its own description; it cannot change routing or its name. */
export const reportMachineBodySchema = z.object(machineDescriptionSchema);
export type ReportMachineBody = z.infer<typeof reportMachineBodySchema>;

/**
 * A computer may pause or resume its own alerts. Pausing only withholds what the
 * computer sends, which it could always do by not sending, so it grants nothing.
 */
export const pauseMachineBodySchema = z.object({
  until: z.number().int().positive().nullable(),
});
export type PauseMachineBody = z.infer<typeof pauseMachineBodySchema>;

export interface PauseMachineResponse {
  alertsPausedUntil: number | null;
}

export const pairStartBodySchema = z.object({
  machineName: z.string().trim().min(1).max(100),
  platform: z.enum(['darwin', 'linux', 'win32', 'other']),
  ...machineDescriptionSchema,
});
export type PairStartBody = z.infer<typeof pairStartBodySchema>;

export interface PairStartResponse {
  pairingId: string;
  pollSecret: string;
  userCode: string;
  expiresAt: number;
  qrPayload: string;
  pollIntervalSec: number;
}

export type PairPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved';
      machineId: string;
      machineToken: string;
      accountId: string;
      deviceCount: number;
    };

export const pairApproveBodySchema = z.object({
  userCode: z.string(),
});
export type PairApproveBody = z.infer<typeof pairApproveBodySchema>;

export interface PairApproveResponse {
  machineName: string;
  platform: MachinePlatform;
}

/** What the approving device sees before it trusts a computer. */
export interface PairPreviewResponse {
  machineName: string;
  platform: MachinePlatform;
  osVersion: string | null;
  arch: string | null;
  cliVersion: string | null;
  /** Where the pairing was started from. */
  place: Place | null;
  createdAt: number;
  expiresAt: number;
}

// Device linking: a new phone shows a code, a trusted phone scans and approves it.

export const linkStartBodySchema = z.object(deviceDescriptionSchema);
export type LinkStartBody = z.infer<typeof linkStartBodySchema>;

export interface LinkStartResponse {
  linkId: string;
  pollSecret: string;
  userCode: string;
  expiresAt: number;
  qrPayload: string;
  pollIntervalSec: number;
}

export type LinkPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; accountId: string; deviceId: string; deviceToken: string };

export interface LinkPreviewResponse {
  deviceName: string;
  platform: DevicePlatform;
  type: DeviceType;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  place: Place | null;
  createdAt: number;
  expiresAt: number;
}

export const linkApproveBodySchema = z.object({
  userCode: z.string(),
});
export type LinkApproveBody = z.infer<typeof linkApproveBodySchema>;

export interface LinkApproveResponse {
  deviceName: string;
  platform: DevicePlatform;
}

/** A computer learns only the names and routing of the devices it alerts. */
export interface MachineMeResponse {
  accountId: string;
  machine: {
    id: string;
    name: string;
    platform: MachinePlatform;
    alertsPausedUntil: number | null;
    presenceDelaySec: number;
  };
  devices: Array<{ id: string; name: string; type: DeviceType; mode: RouteMode }>;
}

export const createRequestBodySchema = z.object({
  kind: z.enum(['ask', 'notify']),
  title: z.string().max(100).optional(),
  body: z.string().min(1).max(LIMITS.bodyMaxLength),
  choices: z
    .array(z.string().trim().min(1).max(LIMITS.choiceMaxLength))
    .max(LIMITS.choicesMax)
    .refine((choices) => new Set(choices).size === choices.length, 'choices must be unique')
    .optional(),
  allowText: z.boolean().optional(),
  timeoutSec: z.number().int().min(10).max(LIMITS.attentionTimeoutSec).optional(),
  ackTimeoutSec: z.number().int().min(10).max(3600).optional(),
  sourceKey: z.string().min(1).max(200).optional(),
  /**
   * The computer's presence hint for an attention alert: true when nobody has
   * used it for a while, so the alert skips the presence delay.
   */
  away: z.boolean().optional(),
});
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

export const resolveRequestBodySchema = z.object({
  sourceKey: z.string().min(1).max(200),
});

export interface ListRequestsResponse {
  requests: PingRequest[];
}

export const answerSchema = z
  .object({
    choice: z.string().max(LIMITS.choiceMaxLength).optional(),
    text: z.string().trim().min(1).max(LIMITS.answerTextMaxLength).optional(),
  })
  .refine((data) => data.choice !== undefined || data.text !== undefined, {
    message: 'either choice or text must be provided',
  });
export type AnswerBody = z.infer<typeof answerSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function buildPairDeepLink(userCode: string): string {
  const params = new URLSearchParams({ code: userCode });
  return `greatping://pair?${params.toString()}`;
}

export function buildLinkDeepLink(userCode: string): string {
  const params = new URLSearchParams({ code: userCode });
  return `greatping://link?${params.toString()}`;
}

export function pickNotificationCategory(req: PingRequest): string {
  if (req.kind === 'notify') return 'NOTIFY';
  if (req.choices.length === 2 && req.choices.includes('yes') && req.choices.includes('no')) {
    return 'ASK_YES_NO';
  }
  if (req.choices.length > 0) return 'ASK_CHOICES';
  return 'ASK_TEXT';
}
