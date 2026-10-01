/**
 * What a host hook event means for GreatPing. Pure functions of the event, so
 * the mapping is testable without a host, network or files.
 *
 * Alerts are generic on purpose: nothing from the prompt (question, command,
 * choices, file names) leaves the computer.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  notification_type?: string;
  stop_hook_active?: boolean;
  permission_context?: { auto_response?: string };
}

export type HookStep =
  /** Open an alert for this prompt; a repeated event reuses it. */
  | { op: 'notify'; correlation: string; title: string; body: string }
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

function finishedSteps(host: string, options: HookOptions): HookStep[] {
  return options.finished
    ? [
        { op: 'resolve-session' },
        {
          op: 'notify',
          correlation: FINISHED,
          title: `${host} is waiting for you`,
          body: `${host} finished its turn. Return to your computer to continue.`,
        },
      ]
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
      return [
        {
          op: 'notify',
          correlation: toolCorrelation(input),
          title: 'Claude Code needs your attention',
          body: 'Return to your computer to answer a question in Claude Code.',
        },
      ];
    case 'PermissionRequest': {
      if (options.alerts && !options.alerts.includes('permissions')) return [];
      if (!input.tool_name || input.tool_name === 'AskUserQuestion') return [];
      // Auto mode decides this one itself; the user is not asked.
      const auto = input.permission_context?.auto_response;
      if (auto === 'allow' || auto === 'deny') return [];
      return [
        {
          op: 'notify',
          correlation: toolCorrelation(input),
          title: 'Claude Code needs your attention',
          body: 'Return to your computer to review a permission request in Claude Code.',
        },
      ];
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
        return [
          {
            op: 'notify',
            correlation: ELICITATION,
            title: 'Claude Code needs your attention',
            body: 'Return to your computer: a tool in Claude Code is asking for input.',
          },
        ];
      }
      if (
        input.notification_type === 'elicitation_complete' ||
        input.notification_type === 'elicitation_response'
      ) {
        return [{ op: 'resolve', correlation: ELICITATION }];
      }
      return [];
    case 'Stop':
      return input.stop_hook_active
        ? [{ op: 'resolve-session' }]
        : finishedSteps('Claude Code', options);
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
      return input.stop_hook_active ? [{ op: 'resolve-session' }] : finishedSteps('Codex', options);
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'SessionEnd':
      return [{ op: 'resolve-session' }];
    default:
      return [];
  }
}
