// claudeCodePermissions.ts — what a passthrough cell ASKS the user, and what
// their answer writes back to the child.
//
// `ExitPlanMode` arrives as an ordinary `can_use_tool`, indistinguishable
// from `Write` or `Bash` on the wire, but a plan is a proposal to accept or
// send back, not a tool to consent to — this file is where the two questions
// part. Routed to the same modal the engine's own `plan_exit` uses, by
// sending the shape `isQuestionShaped` already recognises (absent `allow_always`).

import { toolTitle } from '../claudeCode/translator';
import type { PassthroughMode, ToolPermissionAsk } from '../claudeCode/protocol';
import { emit } from './claudeCodeLog';
import type { BoundCell, ClaudeCodeHost } from './claudeCodeCell';

/** The CLI tool that ENDS plan mode. Its input carries the plan. */
export const EXIT_PLAN_TOOL = 'ExitPlanMode';

/**
 * What the model is told when the user sends a plan back — OUR wording, not
 * a string from the CLI. Must describe a user action and say what to do
 * next, so a capable model stays in plan mode rather than apologising and stopping.
 */
export const KEEP_PLANNING_MESSAGE =
  'The user has not approved this plan yet and wants to keep planning. Stay in plan mode. '
  + 'Do not make any changes. Ask what they want adjusted, or refine the plan yourself, then propose it again.';

/** What a `bypass` request is answered with. Exported for the test that pins the once-per-session
 *  rule to the words the user actually sees. */
export const BYPASS_CLAMP_NOTE =
  'Bypass is not available on a Claude Code chat. Staying on auto-approve for edits — every other tool still asks.';

const APPROVE_PLAN = 'approve_plan';
const KEEP_PLANNING = 'keep_planning';

/** The plan text off an `ExitPlanMode` input. The CLI writes it to `plan`;
 *  the two fallbacks cost a line each and mean a future rename degrades to a
 *  card with no body rather than to no card at all. */
export function planTextOf(input: Record<string, unknown>): string {
  for (const key of ['plan', 'content', 'text']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Route one ask to the surface that fits the question it is really asking. */
export function postPermissionAsk(host: ClaudeCodeHost, cell: BoundCell, ask: ToolPermissionAsk): void {
  if (ask.toolName === EXIT_PLAN_TOOL) { postPlanAsk(host, cell, ask); return; }
  if (cell.alwaysAllow.has(ask.toolName)) {
    cell.driver.answerPermission(ask.requestId, true, ask.input);
    return;
  }
  cell.asks.set(ask.requestId, ask);
  host.post({
    type: 'requestPermission', sessionId: cell.id, toolCallId: ask.requestId,
    title: toolTitle(ask.toolName, ask.input), kind: 'other',
    options: [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow this tool', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
  });
}

/**
 * The plan card: the plan itself in the transcript, then a two-option ask.
 *
 * Posted as scrollback text (not the modal's title) so it survives a tab
 * reattach. No `allow_always` — "approve every future plan unread" is not a
 * grant this feature should be able to make.
 */
function postPlanAsk(host: ClaudeCodeHost, cell: BoundCell, ask: ToolPermissionAsk): void {
  cell.asks.set(ask.requestId, ask);
  const plan = planTextOf(ask.input);
  if (plan) emit(host, cell.id, { type: 'agentText', text: `\n\n${plan}\n\n`, sessionId: cell.id });
  host.post({
    type: 'requestPermission', sessionId: cell.id, toolCallId: ask.requestId,
    title: 'Claude has a plan. Build it, or keep planning?', kind: 'other',
    options: [
      { optionId: APPROVE_PLAN, name: 'Approve & build', kind: 'allow_once' },
      { optionId: KEEP_PLANNING, name: 'Keep planning', kind: 'reject_once' },
    ],
  });
}

/**
 * The user answered. One function for both surfaces, since both arrive as
 * the same `permission` message.
 *
 * A cancelled modal or bar is a DENY, never a silent drop — the child is
 * blocked on this answer. On a plan, that deny is "keep planning".
 */
export function answerPermission(host: ClaudeCodeHost, cell: BoundCell, m: Record<string, unknown>): void {
  const toolCallId = typeof m.toolCallId === 'string' ? m.toolCallId : '';
  const optionId = typeof m.optionId === 'string' ? m.optionId : null;
  const ask = cell.asks.get(toolCallId);
  if (!ask) return;
  cell.asks.delete(toolCallId);
  if (ask.toolName === EXIT_PLAN_TOOL) { answerPlan(host, cell, ask, optionId); return; }
  const allow = optionId === 'allow_once' || optionId === 'allow_always';
  if (optionId === 'allow_always') cell.alwaysAllow.add(ask.toolName);
    // A stale bar: the child died or was interrupted while the ask was on
    // screen, so the audit must not record an approval the tool never got.
  if (!cell.driver.answerPermission(ask.requestId, allow, ask.input)) {
    emit(host, cell.id, { type: 'system', sessionId: cell.id, text: 'That request had already ended — your answer was not sent.' });
    return;
  }
  host.post({ type: 'permissionAudit', toolCallId, title: toolTitle(ask.toolName, ask.input), kind: 'other', action: allow ? 'approved' : 'denied', optionId: optionId ?? 'cancelled', timestamp: stamp() });
}

/**
 * Approve & build, or keep planning.
 *
 * The allow goes out FIRST so the child unblocks immediately; the mode flip
 * follows — `--permission-mode` is read at spawn, so the driver parks and
 * respawns resumed. `planReturnMode` restores the supervision the user
 * actually had, not a hardcoded default.
 */
function answerPlan(host: ClaudeCodeHost, cell: BoundCell, ask: ToolPermissionAsk, optionId: string | null): void {
  const approved = optionId === APPROVE_PLAN;
  if (approved) {
    cell.driver.answerPermission(ask.requestId, true, ask.input);
    const back = cell.planReturnMode ?? 'supervised';
    cell.planReturnMode = undefined;
    cell.mode = back;
    cell.driver.applySettings({ mode: back });
    // The composer's own Plan button is optimistic — it lit up the moment it
    // was pressed — so it has to be told the mode ended here, or it stays lit
    // over a chat that is building.
    host.post({ type: 'modeUpdate', mode: 'build', sessionId: cell.id });
    emit(host, cell.id, { type: 'system', sessionId: cell.id, text: 'Plan approved — Claude Code is building it.' });
  } else {
    cell.driver.answerPermission(ask.requestId, false, ask.input, KEEP_PLANNING_MESSAGE);
    emit(host, cell.id, { type: 'system', sessionId: cell.id, text: 'Still planning. Tell Claude what to change.' });
  }
  host.post({ type: 'permissionAudit', toolCallId: ask.requestId, title: 'Claude Code plan', kind: 'other', action: approved ? 'approved' : 'denied', optionId: optionId ?? 'cancelled', timestamp: stamp() });
}

/**
 * The composer's Access presets → the passthrough modes.
 *
 * Maps onto all three of Claude's real levels, including `acceptEdits` (pre-
 * approved edits, everything else still asking). `bypass` clamps to
 * acceptEdits and says so — there is no unsupervised lane here.
 */
export function modeFromApprove(approve: string): { mode: PassthroughMode; clamped: boolean } {
  if (approve === 'acceptEdits') return { mode: 'acceptEdits', clamped: false };
  if (approve === 'auto') return { mode: 'auto', clamped: false };
  if (approve === 'bypass') return { mode: 'acceptEdits', clamped: true };
  return { mode: 'supervised', clamped: false };
}

export function applyApproveMode(host: ClaudeCodeHost, cell: BoundCell, approve: string): void {
  const { mode, clamped } = modeFromApprove(approve);
  cell.mode = mode;
  cell.driver.applySettings({ mode });
  host.post({ type: 'approveUpdate', mode: clamped ? 'acceptEdits' : approve, sessionId: cell.id });
  // Only when bypass was actually asked for (`clamped`), and only the FIRST time in this chat:
  // ChatPane's YOLO button re-posts `bypass` on every permission bar, and repeating the same
  // paragraph per ask taught the user nothing and read like a fault.
  if (!clamped || cell.bypassNoticed) return;
  cell.bypassNoticed = true;
  host.post({ type: 'system', sessionId: cell.id, text: BYPASS_CLAMP_NOTE });
}

/**
 * The composer's Plan button, on a cell Claude is driving.
 *
 * Both Origami planning modes map onto the CLI's own plan mode, which
 * refuses mutating tools and proposes a plan via `ExitPlanMode`. Silent
 * until the next prompt, since `--permission-mode` is read only at spawn.
 */
export function planModeOf(modeId: string): PassthroughMode | null {
  return modeId === 'plan' || modeId === 'deep-plan' ? 'plan' : null;
}

export function applyPlanMode(host: ClaudeCodeHost, cell: BoundCell, modeId: string): void {
  const planning = planModeOf(modeId);
  if (planning && cell.mode !== 'plan') {
        // Remember what to come back to before overwriting it.
    cell.planReturnMode = cell.mode;
  }
  const next = planning ?? cell.planReturnMode ?? 'supervised';
  if (!planning) cell.planReturnMode = undefined;
  cell.mode = next;
  cell.driver.applySettings({ mode: next });
  host.post({ type: 'modeUpdate', mode: modeId, sessionId: cell.id });
  emit(host, cell.id, {
    type: 'system', sessionId: cell.id,
    text: planning
      ? 'Plan mode — Claude Code. It will research and propose a plan, and change nothing until you approve it.'
      : 'Build mode — Claude Code. Tool approvals are back to your Access setting.',
  });
}

function stamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
