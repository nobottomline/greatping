import type { AttentionReason } from '@greatping/protocol';

/**
 * What a host hook event means for GreatPing. Pure functions of the event, so
 * the mapping is testable without a host, network or files.
 *
 * Alerts say why the host waits, never what about: nothing from the prompt
 * (question, command, choices, file names) leaves the computer.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  correlation?: string;
  reason?: string;
  /** The session's working directory; only its project label may be sent. */
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  notification_type?: string;
  stop_hook_active?: boolean;
  permission_context?: { auto_response?: string };
  conversation_id?: string;
  workspace_roots?: string[];
  status?: string;
}

export type HookStep =
  /** Open an alert for this prompt; a repeated event reuses it. */
  | { op: 'notify'; correlation: string; reason: AttentionReason }
  /** The prompt closed. */
  | { op: 'resolve'; correlation: string }
  /** Nothing earlier in the session is waiting any more. */
  | { op: 'resolve-session' };

export interface HookOptions {
  /** Explicitly opt in to turn-end alerts, including SDK hosts. */
  finished: boolean;
  alerts?: ClaudeAlert[];
}

export type ClaudeAlert = 'questions' | 'permissions' | 'tool-input';
export const CLAUDE_ALERTS: ClaudeAlert[] = ['questions', 'permissions', 'tool-input'];

/** Identifies one tool call across the events that open and close its prompt. */
function toolCorrelation(input: HookInput): string {
  // Earlier Claude Code versions sent PermissionRequest without tool_use_id, so
  // permissions correlate by tool and input, which PostToolUse repeats.
  const detail =
    input.tool_name === 'AskUserQuestion' && input.tool_use_id
      ? input.tool_use_id
      : JSON.stringify(input.tool_input ?? null);
  return JSON.stringify(['tool', input.tool_name, detail]);
}

const ELICITATION = 'elicitation';
const FINISHED = 'finished';

function finishedSteps(options: HookOptions): HookStep[] {
  return options.finished
    ? [{ op: 'resolve-session' }, { op: 'notify', correlation: FINISHED, reason: 'finished' }]
    : [{ op: 'resolve-session' }];
}

export function claudeSteps(input: HookInput, options: HookOptions): HookStep[] {
  const event = input.hook_event_name;
  if (!input.session_id) return [];
  switch (event) {
    case 'PreToolUse':
      if (
        input.tool_name !== 'AskUserQuestion' ||
        (options.alerts && !options.alerts.includes('questions'))
      )
        return [];
      return [{ op: 'notify', correlation: toolCorrelation(input), reason: 'question' }];
    case 'PermissionRequest': {
      if (options.alerts && !options.alerts.includes('permissions')) return [];
      if (!input.tool_name || input.tool_name === 'AskUserQuestion') return [];
      // Auto mode decides this one itself; the user is not asked.
      const auto = input.permission_context?.auto_response;
      if (auto === 'allow' || auto === 'deny') return [];
      return [{ op: 'notify', correlation: toolCorrelation(input), reason: 'permission' }];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return input.tool_name ? [{ op: 'resolve', correlation: toolCorrelation(input) }] : [];
    case 'Notification':
      if (
        input.notification_type === 'elicitation_dialog' ||
        input.notification_type === 'elicitation_url_dialog'
      ) {
        if (options.alerts && !options.alerts.includes('tool-input')) return [];
        return [{ op: 'notify', correlation: ELICITATION, reason: 'input' }];
      }
      if (
        input.notification_type === 'elicitation_complete' ||
        input.notification_type === 'elicitation_response'
      ) {
        return [{ op: 'resolve', correlation: ELICITATION }];
      }
      return [];
    case 'Stop':
      return input.stop_hook_active ? [{ op: 'resolve-session' }] : finishedSteps(options);
    case 'UserPromptSubmit':
    case 'SessionEnd':
      return [{ op: 'resolve-session' }];
    default:
      return [];
  }
}

/**
 * Codex: only the end of a turn is a reliable "the user is needed" signal.
 * Its PermissionRequest may fire before automatic review decides, so it is
 * not used (see docs/agent-integrations.md).
 */
export function codexSteps(input: HookInput, options: HookOptions): HookStep[] {
  if (!input.session_id) return [];
  switch (input.hook_event_name) {
    case 'Stop':
      return input.stop_hook_active ? [{ op: 'resolve-session' }] : finishedSteps(options);
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'SessionEnd':
      return [{ op: 'resolve-session' }];
    default:
      return [];
  }
}

/** Native adapters strip host data before stdin; accept only lifecycle metadata. */
export function nativeSteps(input: HookInput, options: HookOptions): HookStep[] {
  if (!input.session_id) return [];
  switch (input.hook_event_name) {
    case 'PromptOpen':
      return input.correlation && ['question', 'permission', 'input'].includes(input.reason ?? '')
        ? [
            {
              op: 'notify',
              correlation: input.correlation,
              reason: input.reason as AttentionReason,
            },
          ]
        : [];
    case 'PromptClose':
      return input.correlation ? [{ op: 'resolve', correlation: input.correlation }] : [];
    case 'Finished':
      return finishedSteps(options);
    case 'Started':
    case 'SessionEnd':
      return [{ op: 'resolve-session' }];
    default:
      return [];
  }
}

/** Cursor has no documented native question/approval-wait event. */
export function cursorSteps(input: HookInput, options: HookOptions): HookStep[] {
  if (!input.conversation_id && !input.session_id) return [];
  switch (input.hook_event_name) {
    case 'stop':
      return input.status === 'completed' ? finishedSteps(options) : [{ op: 'resolve-session' }];
    case 'beforeSubmitPrompt':
    case 'sessionStart':
    case 'sessionEnd':
      return [{ op: 'resolve-session' }];
    default:
      return [];
  }
}
