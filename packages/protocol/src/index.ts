import { z } from 'zod';
import {
  ALERT_HOSTS,
  type AlertHost,
  ATTENTION_REASONS,
  type AttentionReason,
  LIMITS,
} from './constants';
import {
  CATEGORY_HINTS,
  type CategoryHint,
  type Envelope,
  envelopeSchema,
} from './crypto/envelope';
import type { MemberKeys } from './crypto/keys';

export * from './constants';
export {
  CATEGORY_HINTS,
  type CategoryHint,
  type Envelope,
  type EnvelopePurpose,
} from './crypto/envelope';

export const PROTOCOL_VERSION = '0.1.0';

/** The hosted service; the CLI and store builds use only this origin. */
export const SERVICE_ORIGIN = 'https://api.greatping.com';

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

/**
 * Which alerts a device wants, independent of the computer that sends them:
 * decision: a native prompt blocks the agent; finished: the agent stopped;
 * question: an explicit GreatPing question; notice: a message.
 */
export type AlertCategory = 'decision' | 'finished' | 'question' | 'notice';
export const ALERT_CATEGORIES: readonly AlertCategory[] = [
  'decision',
  'finished',
  'question',
  'notice',
];

export function reasonCategory(reason: AttentionReason): 'decision' | 'finished' {
  return reason === 'finished' || reason === 'error' ? 'finished' : 'decision';
}

/** Whether a computer sends project labels with its alerts. */
export type ProjectLabels = 'folder' | 'hidden';

export type NotificationState = 'enabled' | 'denied' | 'unavailable' | 'unknown';

/**
 * A daily window, in minutes after local midnight, when a device is not
 * notified. `start > end` spans midnight (22:00 to 07:00). With
 * `allowDecisions`, an agent waiting for an approval or answer, and an
 * explicit question, still notify.
 */
export interface QuietHours {
  start: number;
  end: number;
  allowDecisions: boolean;
}

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
  /** Push notifications on this device include project labels. */
  projectsInNotifications: boolean;
  /** When this device stays silent; alerts still reach its inbox. */
  quietHours: QuietHours | null;
  /** IANA time zone the device last reported; quiet hours follow it. */
  timeZone: string | null;
  approvedByDeviceId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPlace: Place | null;
  /** When this device may remove devices and computers that joined before it. */
  seniorAt: number;
  /** This device's ceremony confirmation tag after it was linked; null before or without keys. */
  ceremonyTag: string | null;
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
  /** Whether the computer labels its alerts with the project's folder name. */
  projectLabels: ProjectLabels;
  lastAlertAt: number | null;
  alertsLast7Days: number;
  /** The computer's ceremony confirmation tag after pairing; null before or without keys. */
  ceremonyTag: string | null;
  /** The manifest version the computer last reported using; null if it has not. */
  manifestVersion: number | null;
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

/** A decrypted answer (`answer` envelope payload). */
export interface Answer {
  choice?: string;
  text?: string;
}

export type RequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired' | 'resolved';
export type EscalationStage = 'primary' | 'all' | 'reminder' | 'done';

export type RequestKind = 'attention' | 'ask' | 'notify';

/**
 * A project an alert belongs to: an opaque key of its root. Its label travels
 * only inside the envelope (docs/e2e-encryption.md).
 */
export interface ProjectRef {
  key: string;
}

export interface PingRequest {
  id: string;
  accountId: string;
  machineId: string;
  machineName: string;
  /**
   * attention: a native host prompt or a finished turn, observed by a hook;
   * ask: an explicit GreatPing question; notify: an explicit message.
   */
  kind: RequestKind;
  category: AlertCategory;
  host: AlertHost;
  /** Why the host needs the user; attention alerts only. */
  reason: AttentionReason | null;
  /** Opaque id of the host's chat session; one open attention alert per thread. */
  thread: string | null;
  project: ProjectRef | null;
  /** Questions: which notification buttons fit, the only plaintext about the choices. */
  hint: CategoryHint | null;
  /**
   * The content, sealed by the computer to the account's devices: the text of
   * a question or message, its choices, and the project label. Null for an
   * attention alert without a label, and once the content is erased.
   */
  envelope: Envelope | null;
  status: RequestStatus;
  stage: EscalationStage;
  /** The answer, sealed by the answering device to the computer and every device. */
  answerEnvelope: Envelope | null;
  answeredByDeviceId: string | null;
  createdAt: number;
  expiresAt: number;
  ackedAt: number | null;
  answeredAt: number | null;
  /** Created while the computer's alerts were paused: listed, but no device was alerted. */
  paused?: boolean;
  /** When the request stopped waiting; absent while it is pending. */
  finishedAt?: number;
  /**
   * The envelopes were deleted `historyRetentionDays` after the request
   * finished; only its outcome and times remain.
   */
  contentErased?: boolean;
}

export type PushData =
  | {
      type: 'request';
      requestId: string;
      kind: RequestKind;
      hint: CategoryHint | null;
      stage: EscalationStage;
      /**
       * What the server says about the request, so the iOS extension can check
       * it against the envelope's signed fields as the app does.
       */
      host: AlertHost;
      reason: AttentionReason | null;
      projectKey: string | null;
      createdAt: number;
      /** The source of an alert from the command itself (`alertSource`). */
      machineName: string;
      /** The content for this device to open; left out when the push would be too large. */
      envelope?: Envelope;
    }
  | { type: 'resolved'; requestId: string; status: RequestStatus }
  /** Another device opened the request; its alert can be cleared here. */
  | { type: 'acked'; requestId: string }
  /** Security notice: the account's devices or computers changed. */
  | { type: 'security'; event: AccountEventType }
  /** The account has been inactive and is about to be deleted; opening the app keeps it. */
  | { type: 'account'; notice: 'inactive' }
  /** Another device deleted the account; this device is signed out. */
  | { type: 'account'; notice: 'deleted' }
  /** A test notification (`greatping test`, Send Test Notification); it alerts nothing else. */
  | { type: 'test'; testId: string };

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
  /** Optional account-wide product analytics; existing clients remain opted out. */
  analyticsEnabled: z.boolean().optional(),
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
    .array(z.enum(['decision', 'finished', 'question', 'notice']))
    .max(4)
    .optional(),
  breakThroughFocus: z.boolean().optional(),
  projectsInNotifications: z.boolean().optional(),
  quietHours: z
    .strictObject({
      start: z.number().int().min(0).max(1439),
      end: z.number().int().min(0).max(1439),
      allowDecisions: z.boolean(),
    })
    .refine((window) => window.start !== window.end, 'quiet hours need a start and a different end')
    .nullable()
    .optional(),
  /** IANA name such as "Europe/Berlin"; the server checks it is a time zone it knows. */
  timeZone: z.string().min(1).max(64).optional(),
});
export type UpdateDeviceBody = z.infer<typeof updateDeviceBodySchema>;

export interface MeResponse {
  accountId: string;
  device: Device;
  devices: Device[];
  machines: Machine[];
  routes: Route[];
  /** The account's latest manifest version; null for an account created before keys. */
  manifestVersion: number | null;
  /** Absent on older servers. No credential is ever used as an analytics identity. */
  analytics?: AccountAnalytics;
}

export interface AccountAnalytics {
  enabled: boolean;
  distinctId: string | null;
}

export const analyticsPreferencesSchema = z.object({ enabled: z.boolean() }).strict();

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
  projectLabels: z.enum(['folder', 'hidden']).optional(),
});
export type UpdateMachineBody = z.infer<typeof updateMachineBodySchema>;

/**
 * A computer's recent projects as it last reported them: a `projects`
 * envelope the devices open (folder names, names set from a device, hidden).
 * The server only stores it.
 */
export interface ListMachineProjectsResponse {
  envelope: Envelope | null;
  reportedAt: number | null;
}

/**
 * A device renames or hides a project: a `project` envelope queued for the
 * computer, which applies it to its own settings (docs/e2e-encryption.md).
 */
export const projectCommandBodySchema = z.strictObject({ envelope: envelopeSchema });
export type ProjectCommandBody = z.infer<typeof projectCommandBodySchema>;

/** Queued project commands, returned once to the computer and then deleted. */
export interface ProjectCommandsResponse {
  commands: Envelope[];
}

/**
 * Sent with every request a computer creates: how many project commands wait
 * for it, so it fetches them at once instead of with its next hourly report.
 */
export const PROJECT_COMMANDS_HEADER = 'x-greatping-project-commands';

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
export const reportMachineBodySchema = z.object({
  ...machineDescriptionSchema,
  /** The manifest version the computer verified and uses. */
  manifestVersion: z.number().int().positive().optional(),
  /** Its recent projects, sealed to the account's devices; replaces the previous report. */
  projectsEnvelope: envelopeSchema.optional(),
});
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

/**
 * Sent with every request a computer creates: its current project-label mode,
 * so a change made on a device reaches the computer with its next alert
 * instead of its next hourly report.
 */
export const PROJECT_LABELS_HEADER = 'x-greatping-project-labels';

/**
 * A computer chooses whether it labels its alerts with project folder names.
 * It only decides what it sends itself, so, like a pause, it grants nothing.
 */
export const projectLabelsBodySchema = z.strictObject({
  mode: z.enum(['folder', 'hidden']),
});
export type ProjectLabelsBody = z.infer<typeof projectLabelsBodySchema>;

export interface ProjectLabelsResponse {
  projectLabels: ProjectLabels;
}

// ---------------------------------------------------------------------------
// Keys, the account manifest and the pairing ceremony (docs/device-keys.md).
// These schemas bound shape and size at the API; `verifyNext` and the ceremony
// functions in `@greatping/protocol/crypto` decide what is valid.
// ---------------------------------------------------------------------------

const base64url = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));
const memberIdSchema = z.string().regex(/^[\w-]{1,64}$/);
const publicKeySchema = z.strictObject({
  alg: z.string().max(20),
  key: z.string().max(200),
});
export const memberKeysSchema = z.strictObject({ sign: publicKeySchema, enc: publicKeySchema });

export const manifestSchema = z.strictObject({
  account: memberIdSchema,
  version: z.number().int().positive(),
  previous: z.string().max(100),
  change: z.strictObject({
    op: z.enum(['genesis', 'add', 'remove', 'rotate']),
    target: memberIdSchema,
  }),
  members: z
    .array(
      z.strictObject({
        kind: z.enum(['device', 'computer']),
        id: memberIdSchema,
        sign: publicKeySchema,
        enc: publicKeySchema,
        addedAt: z.number().int().nonnegative(),
        addedBy: memberIdSchema.nullable(),
      }),
    )
    .min(1)
    .max(LIMITS.manifestMembersMax),
  signer: memberIdSchema,
  createdAt: z.number().int().nonnegative(),
  signature: z.string().max(200),
});
export type ManifestPayload = z.infer<typeof manifestSchema>;

/** A CPace public share (32 bytes) and a confirmation tag (64 bytes), base64url. */
const shareSchema = base64url(32);
const tagSchema = base64url(64);
/** The CPace session id (16 random bytes) the initiator draws, as the share depends on it. */
const sessionSchema = base64url(16);

/** The approving device's answer, relayed to the initiator. */
export interface CeremonyResponse {
  share: string;
  device: string;
  manifestHash: string;
  tag: string;
}

/** The initiator's confirmation tag, posted once it has verified the answer. */
export const ceremonyConfirmBodySchema = z.strictObject({ tag: tagSchema });
export type CeremonyConfirmBody = z.infer<typeof ceremonyConfirmBodySchema>;

/** A new manifest version that changes no membership by itself (genesis, rotation, cleanup). */
export const postManifestBodySchema = z.strictObject({ manifest: manifestSchema });
export type PostManifestBody = z.infer<typeof postManifestBodySchema>;

export interface ManifestsResponse {
  /** Versions after the requested one, oldest first. */
  manifests: ManifestPayload[];
}

/** Removing a member of a keyed account comes with the version that removes it. */
export const removeMemberBodySchema = z.strictObject({ manifest: manifestSchema });
export type RemoveMemberBody = z.infer<typeof removeMemberBodySchema>;

export const pairStartBodySchema = z.object({
  machineName: z.string().trim().min(1).max(100),
  platform: z.enum(['darwin', 'linux', 'win32', 'other']),
  ...machineDescriptionSchema,
  /** The computer's public keys and its CPace share; the secret half never leaves it. */
  keys: memberKeysSchema,
  session: sessionSchema,
  share: shareSchema,
});
export type PairStartBody = z.infer<typeof pairStartBodySchema>;

export interface PairStartResponse {
  pairingId: string;
  pollSecret: string;
  /** The first half of the code; the computer adds its secret half. */
  lookup: string;
  /** The id the computer will have, named by the approving device's manifest version. */
  machineId: string;
  expiresAt: number;
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
      ceremony: CeremonyResponse;
      /** The account's manifest chain from genesis. */
      manifests: ManifestPayload[];
    };

export const pairApproveBodySchema = z.strictObject({
  lookup: z.string(),
  share: shareSchema,
  tag: tagSchema,
  /** The next version, adding this computer with the keys of the preview. */
  manifest: manifestSchema,
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
  machineId: string;
  keys: MemberKeys;
  /** CPace session id and share, as the computer sent them. */
  session: string;
  share: string;
}

// Device linking: a new phone shows a code, a trusted phone scans and approves it.

export const linkStartBodySchema = z.object({
  ...deviceDescriptionSchema,
  keys: memberKeysSchema,
  session: sessionSchema,
  share: shareSchema,
});
export type LinkStartBody = z.infer<typeof linkStartBodySchema>;

export interface LinkStartResponse {
  linkId: string;
  pollSecret: string;
  lookup: string;
  /** The id this device will have once approved. */
  deviceId: string;
  expiresAt: number;
  pollIntervalSec: number;
}

export type LinkPollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved';
      accountId: string;
      deviceId: string;
      deviceToken: string;
      ceremony: CeremonyResponse;
      manifests: ManifestPayload[];
    };

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
  deviceId: string;
  keys: MemberKeys;
  /** CPace session id and share, as the new device sent them. */
  session: string;
  share: string;
}

export const linkApproveBodySchema = z.strictObject({
  lookup: z.string(),
  share: shareSchema,
  tag: tagSchema,
  /** The next version, adding this device with the keys of the preview. */
  manifest: manifestSchema,
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
    /** The computer sends project labels only in `folder` mode. */
    projectLabels: ProjectLabels;
  };
  devices: Array<{ id: string; name: string; type: DeviceType; mode: RouteMode }>;
}

/** Hashes and keys a computer derives locally; never raw session ids or paths. */
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'expected an opaque id');
const hostSchema = z.enum(ALERT_HOSTS);
export const createRequestBodySchema = z.discriminatedUnion('kind', [
  /**
   * A native prompt or finished turn observed by a hook. The server keeps one
   * open alert per thread: the same correlation returns the open alert, a new
   * one resolves the previous alert of the thread.
   */
  z.strictObject({
    kind: z.literal('attention'),
    host: hostSchema,
    reason: z.enum(ATTENTION_REASONS),
    thread: opaqueId,
    /** Identifies one prompt within the thread across retries and integrations. */
    correlation: opaqueId,
    projectKey: opaqueId.optional(),
    /** Only with a project label (Folder name mode): the label is its whole content. */
    envelope: envelopeSchema.optional(),
    timeoutSec: z.number().int().min(10).max(LIMITS.attentionTimeoutSec).optional(),
    /**
     * The computer's presence hint: true when nobody has used it for a while,
     * so the alert skips the presence delay.
     */
    away: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('ask'),
    host: hostSchema,
    thread: opaqueId.optional(),
    projectKey: opaqueId.optional(),
    hint: z.enum(CATEGORY_HINTS),
    envelope: envelopeSchema,
    timeoutSec: z.number().int().min(10).max(LIMITS.attentionTimeoutSec).optional(),
    ackTimeoutSec: z.number().int().min(10).max(3600).optional(),
  }),
  z.strictObject({
    kind: z.literal('notify'),
    host: hostSchema,
    thread: opaqueId.optional(),
    projectKey: opaqueId.optional(),
    envelope: envelopeSchema,
    timeoutSec: z.number().int().min(10).max(LIMITS.attentionTimeoutSec).optional(),
  }),
]);
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

/** Closes attention alerts of a thread: one prompt, or every open one without a correlation. */
export const resolveRequestBodySchema = z.strictObject({
  host: hostSchema,
  thread: opaqueId,
  correlation: opaqueId.optional(),
});
export type ResolveRequestBody = z.infer<typeof resolveRequestBodySchema>;

export interface ResolveRequestResponse {
  /** Open alerts this call closed. */
  resolved: number;
}

/**
 * How a test notification fared on one device. `sending`: Expo accepted it and
 * has not heard back from Apple or Google yet; `accepted`: Apple or Google
 * accepted it for the device (not proof that it was displayed); `failed`: they
 * or Expo refused it; `skipped`: not sent, see `reason`.
 */
export type PushTestStatus = 'sending' | 'accepted' | 'failed' | 'skipped';

export interface PushTestDevice {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
  /** The device's route from the testing computer; null for a test from a device. */
  mode: RouteMode | null;
  status: PushTestStatus;
  /** Why it was skipped or failed, as a stable code. */
  reason?:
    | 'off'
    | 'no_token'
    | 'device_not_registered'
    | 'credentials'
    | 'rate_limited'
    | 'provider_error';
  /** The push service's own error code, for support (e.g. "InvalidCredentials"). */
  detail?: string;
}

export interface PushTestResponse {
  id: string;
  createdAt: number;
  devices: PushTestDevice[];
  /** True while a device is still `sending`; ask again in a few seconds. */
  pending: boolean;
}

export interface ListRequestsResponse {
  requests: PingRequest[];
  /** Pass as `before` to get the next, older page; null on the last page. */
  nextCursor?: string | null;
  /** How many requests match in total; on the first page of the history only. */
  total?: number;
}

/** An answer, sealed by the device (`answer` envelope); the server only relays it. */
export const answerSchema = z.strictObject({ envelope: envelopeSchema });
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

export const HOST_NAMES: Record<AlertHost, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  'gemini-cli': 'Gemini CLI',
  cli: 'Terminal',
  other: 'Agent',
};

/** What an attention alert says; the server and the app render the same words. */
export const REASON_TEXT: Record<AttentionReason, string> = {
  permission: 'Needs your approval',
  question: 'Has a question for you',
  input: 'Needs your input',
  finished: 'Finished its turn',
  error: 'Stopped with an error',
};

/**
 * Whether a waiting request blocks someone: a native prompt the agent waits on,
 * or an explicit question. The inbox lists these first ("Needs a decision"),
 * then finished turns and notices.
 */
export function needsDecision(req: Pick<PingRequest, 'category'>): boolean {
  return req.category === 'decision' || req.category === 'question';
}

/**
 * What a device read from a request's envelope that changes how it is shown.
 * Without it (not opened, not addressed, or nothing sealed) an alert shows only
 * what the server knows.
 */
export interface RequestContent {
  title?: string;
  body?: string;
  projectLabel?: string;
}

/** Where an alert comes from: "Codex · billing-api", or the computer for the command itself. */
export function alertSource(
  req: Pick<PingRequest, 'host' | 'machineName'>,
  projectLabel?: string | null,
): string {
  // The GreatPing command itself has no agent name; the computer is the source.
  const origin = req.host === 'cli' ? req.machineName || 'Computer' : HOST_NAMES[req.host];
  return projectLabel ? `${origin} · ${projectLabel}` : origin;
}

/**
 * Title and body of an alert. With the opened content: "Codex · billing-api"
 * and what it needs, or the question or message an agent sent. Without it, the
 * generic text the server can render, which never contains content. Without
 * `withProject`, the label is left out (devices that hide project names in
 * notifications).
 */
export function describeRequest(
  req: Pick<PingRequest, 'kind' | 'host' | 'reason' | 'machineName'>,
  content?: RequestContent | null,
  options: { withProject?: boolean } = {},
): { title: string; body: string } {
  const label = options.withProject !== false ? content?.projectLabel : undefined;
  const source = alertSource(req, label);
  if (req.kind === 'attention') {
    return { title: source, body: req.reason ? REASON_TEXT[req.reason] : 'Needs your attention' };
  }
  if (content?.body) return { title: content.title ?? source, body: content.body };
  return {
    title: source,
    body: req.kind === 'ask' ? 'Has a question for you' : 'Sent you a message',
  };
}

/**
 * Which buttons fit a question, computed by the computer from its choices
 * (the server cannot read them): Yes and No for "Yes"/"No" in any spelling,
 * and a Reply field when the question accepts the user's own words.
 */
export function categoryHint(choices: readonly string[], allowText: boolean): CategoryHint {
  if (choices.length === 0) return 'text';
  const lower = choices.map((choice) => choice.trim().toLowerCase());
  const yesNo = lower.length === 2 && lower.includes('yes') && lower.includes('no');
  if (yesNo) return allowText ? 'yes_no_text' : 'yes_no';
  return allowText ? 'choices_text' : 'choices';
}

const CATEGORY_IDS: Record<CategoryHint, string> = {
  text: 'ASK_TEXT',
  yes_no: 'ASK_YES_NO',
  yes_no_text: 'ASK_YES_NO_TEXT',
  choices: 'ASK_CHOICES',
  choices_text: 'ASK_CHOICES_TEXT',
};

/**
 * The notification's category (its buttons). Other choices than Yes and No
 * cannot be buttons (iOS registers button titles in advance), so a tap opens
 * them in the app.
 */
export function pickNotificationCategory(req: Pick<PingRequest, 'kind' | 'hint'>): string {
  if (req.kind !== 'ask') return 'NOTIFY';
  return CATEGORY_IDS[req.hint ?? 'text'];
}
