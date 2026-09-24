// protocol.ts — the Claude Code CLI stream-json contract, as pure functions: the arg vector, the
// child env, the line splitter, and the readers/builders for the wire. Nothing here spawns, reads a
// file, or touches vscode.

import { imageBlocks, type ImagePart } from './images';
import { ISOLATION_FLAGS, assertNoBypass } from './flags';
// Flag POLICY lives in flags.ts; re-exported so the wire contract stays one import.
export { FORBIDDEN_FLAGS, ISOLATION_FLAGS, assertNoBypass } from './flags';
// Attachments live in images.ts; re-exported so the wire contract stays one import.
export { IMAGE_MEDIA_TYPES, imagePartOf, type ImagePart } from './images';
// The turn ACCOUNTING read lives in turnUsage.ts (its rule: the last iteration, not the summed
// turn); re-exported so the wire contract stays one import.
export { resultUsage, type ResultUsage } from './turnUsage';

/** One decoded stdout line. `type` is the only field the CLI guarantees. */
export interface ClaudeEvent {
  type: string;
  [key: string]: unknown;
}

/** Four supervision levels and NO bypass. The names are ours; the CLI mode each
 *  maps to is `CLI_PERMISSION_MODE`. */
export type PassthroughMode = 'supervised' | 'acceptEdits' | 'auto' | 'plan';

/**
 * supervised → the CLI asks about everything its own rules did not settle.
 * acceptEdits → the CLI pre-approves edits; the rest still comes to us.
 * auto → same CLI mode; the driver answers the remaining asks itself.
 * plan → the CLI's own plan mode: refuses every mutating tool and ends by calling `ExitPlanMode`.
 * There is deliberately no `bypassPermissions` entry; `assertNoBypass` makes adding one a throw.
 */
export const CLI_PERMISSION_MODE: Record<PassthroughMode, string> = {
  supervised: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'acceptEdits',
  plan: 'plan',
};

export interface ArgsOptions {
  /** Model id or alias (`haiku`, `sonnet`, `claude-opus-4-6`…). Omitted → the
   *  user's own configured default, which is the honest passthrough default. */
  model?: string;
  mode: PassthroughMode;
  /** Provider session id to continue. Only valid when the cwd is unchanged. */
  resumeSessionId?: string;
  /** Smoke/test lever only — production turns are never capped. */
  maxTurns?: number;
  /** A ONE-SHOT reviewer run rather than a chat — see `ISOLATION_FLAGS`. */
  isolated?: boolean;
}

/** The working vector: bidirectional stream-json, partial messages on, permission prompts routed to
 *  our stdin, the user's own settings sources loaded. No `-p` — that would make it one-shot. */
export function buildArgs(options: ArgsOptions): string[] {
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--setting-sources=user,project,local',
    '--permission-mode', CLI_PERMISSION_MODE[options.mode],
  ];
  if (options.model) args.push('--model', options.model);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns));
  if (options.isolated) args.push(...ISOLATION_FLAGS);
  assertNoBypass(args);
  return args;
}

/** The child's env: the parent's, minus every CLAUDE* key (so the child is a fresh session) and
 *  every ORIGAMI_* key (never hand our own tokens to a third-party binary). Nothing is injected —
 *  the CLI authenticates itself from ~/.claude. One exception: `CLAUDE_CODE_ENABLE_*` survives the
 *  scrub, since it names a capability the user turned on in their own shell, not a credential. */
export function childEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE') && !k.startsWith('CLAUDE_CODE_ENABLE_')) continue;
    if (k.startsWith('ORIGAMI_')) continue;
    out[k] = v;
  }
  return out;
}

/** stdout arrives in arbitrary chunks; the contract is one JSON object per
 *  line. Keeps the trailing partial until its newline shows up. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }
  /** Whatever is left when the pipe closes without a final newline. */
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/** A line the CLI wrote → an event, or null when it is not JSON at all.
 *  Lenient by design: a future CLI printing a stray banner must not kill the
 *  session. */
export function parseLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const ev = parsed as Record<string, unknown>;
    if (typeof ev.type !== 'string') return null;
    return ev as ClaudeEvent;
  } catch {
    return null;
  }
}

/** True for anything a sub-agent produced. Those events are dropped from the transcript and
 *  excluded from the context meter — a Task's child spends its own window, not the parent's. */
export function isSubagentEvent(ev: ClaudeEvent): boolean {
  const parent = ev.parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0;
}

/** The CLI stamps its own session id on every event. We adopt it rather than
 *  minting one: the id it resumes from is the id it tells us. */
export function sessionIdOf(ev: ClaudeEvent): string | undefined {
  return typeof ev.session_id === 'string' && ev.session_id.length > 0 ? ev.session_id : undefined;
}

/** A `control_request` the CLI is BLOCKED on. `sdk_control_request` is the
 *  same frame under an older name — both accepted, per monocode's parser. */
export function controlRequestOf(ev: ClaudeEvent): { requestId: string; subtype: string; request: Record<string, unknown> } | null {
  if (ev.type !== 'control_request' && ev.type !== 'sdk_control_request') return null;
  const req = (ev.request ?? {}) as Record<string, unknown>;
  const requestId = typeof ev.request_id === 'string' ? ev.request_id : '';
  const subtype = typeof req.subtype === 'string' ? req.subtype : '';
  if (!requestId) return null;
  return { requestId, subtype, request: req };
}

/** `control_cancel_request` — the CLI RETIRING a control request it is no longer waiting on: its
 *  own ask timeout fired, or the turn was torn down under it. Read off the installed CLI's schema
 *  (`{type:"control_cancel_request", request_id}`, described there as "Cancels a currently open
 *  control request"). Unhandled, it left a permission bar on screen answering nobody. */
export function controlCancelOf(ev: ClaudeEvent): string | null {
  if (ev.type !== 'control_cancel_request') return null;
  return typeof ev.request_id === 'string' && ev.request_id ? ev.request_id : null;
}

export interface ToolPermissionAsk {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The permission ask: `can_use_tool`. Anything else is an unknown control
 *  subtype and gets `controlAck` so the child never stalls waiting on us. */
export function permissionAskOf(ev: ClaudeEvent): ToolPermissionAsk | null {
  const ctl = controlRequestOf(ev);
  if (!ctl || ctl.subtype !== 'can_use_tool') return null;
  const input = ctl.request.input;
  return {
    requestId: ctl.requestId,
    toolName: typeof ctl.request.tool_name === 'string' ? ctl.request.tool_name : '',
    input: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
  };
}

/** Allow — `updatedInput` echoes the tool input back (the CLI treats it as the
 *  input to actually run, so echoing is "allow unchanged"). */
export function allowResponse(requestId: string, updatedInput: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput } },
  };
}

/** Deny. The message is what the MODEL is told, so it reads as a user action,
 *  not a crash. */
export function denyResponse(requestId: string, message = 'User declined tool execution.'): Record<string, unknown> {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } },
  };
}

/** Empty ack for a control subtype we do not implement. A control request left
 *  unanswered is a hung child, so "unknown" must still be answered. */
export function controlAck(requestId: string): Record<string, unknown> {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } };
}

/** The handshake the spike sent before its first turn. */
export function initializeRequest(requestId: string): Record<string, unknown> {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } };
}

/** Interrupt: a control request the child answers by aborting the turn. The
 *  driver also seals its own turn locally — it never waits for the child to be
 *  graceful. */
export function interruptRequest(requestId: string): Record<string, unknown> {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

/** One user turn. `session_id: ''` on the first turn lets the CLI mint the id; afterwards we echo
 *  the adopted one back. Images are additive: no attachment yields a byte-identical frame to the
 *  text-only one, and attachments ride as extra blocks after the text. */
export function userMessage(text: string, sessionId = '', images: readonly ImagePart[] = []): Record<string, unknown> {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }, ...imageBlocks(images)] },
  };
}
