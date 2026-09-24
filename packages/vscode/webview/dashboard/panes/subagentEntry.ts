// subagentEntry.ts: roster admission rules — which messages are
// sub-agents, their identity, and how they're doing. Split from
// subagentRows.ts: this file decides who belongs; that decides what the drawer shows for survivors.

import type { SubagentSpan } from './subagentTiming';
import type { SubagentTokens } from './subagentTokens';
import type { SubagentThinking } from './subagentThinking';

/** The subset of ChatPane's `Message` this reads (run span: subagentTiming.ts).
 *  Structural — the pane's own carries thirty fields this must not know. */
export interface SubagentMessage extends SubagentSpan {
  taskSessionId?: string;
  label?: string;
  toolStatus?: string;
  /** Epoch ms the card was BUILT = the RELOAD instant in a reopened chat, so
   *  subagentTiming.ts reaches for it LAST. */
  timestamp?: number;
  taskBackground?: boolean;
  taskModel?: string;
  /** The child's token spend, re-sent per child step (subagentTokens.ts).
   *  Absent against an engine that rides no tokens — the row prints nothing. */
  taskTokens?: SubagentTokens;
  taskDone?: 'completed' | 'error';
  taskStream?: string;
  /** The child's CURRENT run of reasoning (subagentThinking.ts). Absent while it
   *  is not thinking, and against an engine that forwards no thought — blank is
   *  an answer here, like the token rider beside it. */
  taskThinking?: SubagentThinking;
  /** The model's own 3-5 word brief for this spawn, and the agent type it asked
   *  for, both off the `task` call's `rawInput` (subagentLabel.ts). They are what
   *  every surface NAMES the sub-agent by; the card's own header is the word
   *  `task`. Absent against an engine that rides no input. */
  taskDescription?: string;
  taskAgentType?: string;
  /** `_meta.origami_tool_name`. Only a `task` card can be a sub-agent at all —
   *  the same literal ToolCard.svelte already dispatches its task renderer on. */
  toolName?: string;
  /** The launcher card's ACP tool-call id — the ONLY identity a spawn that
   *  never reached a child session will ever have. */
  toolCallId?: string;
}

/** `queued` = ACP's `pending` (accepted, not started). `failed` = the
 *  spawn never happened. `done`/`error` are the two ways a run ends. */
export type SubagentState = 'running' | 'queued' | 'failed' | 'done' | 'error';

/** ACP's terminal states, listed as what ends a run rather than what
 *  continues one: an unseen status stays "still out" (visible annoyance beats silently dropped). */
const TERMINAL = new Set(['completed', 'failed']);

const status = (m: SubagentMessage) => (m.toolStatus ?? '').trim();

/** A spawn that never happened: a `task` call denied or naming an agent
 *  type that doesn't exist. Listed, not dropped, so a fan-out of five
 *  with one denied still shows all five. Permanent, not a state that settles. */
function failedSpawn(m: SubagentMessage): boolean {
  return !m.taskSessionId && m.toolName === 'task' && status(m) === 'failed';
}

/** Is this sub-agent still out? A foreground call blocks until the child
 *  returns, so its card status is the child's life. A background call
 *  (the ordinary case) returns the instant the child spawns and reaches
 *  `completed` while the child keeps working, so it ends only on `taskDone`. */
function stillOut(m: SubagentMessage): boolean {
  if (m.taskBackground === true) return !m.taskDone;
  return !TERMINAL.has(status(m));
}

/** Has this row STOPPED? The one place that question is answered, because two
 *  surfaces need the same answer and must not drift: subagentTiming.ts refuses
 *  to age a stopped row off the wall clock, and groupSubagents puts it in the
 *  Complete band. Written as the positive of the two states that are still out
 *  rather than a list of terminal ones, so an unrecognised state reads as "still
 *  out" — visibly wrong in the Running band beats silently frozen. */
export function isSettled(state: SubagentState): boolean {
  return state !== 'running' && state !== 'queued';
}

/** Which roster row this message belongs to, or none. Also the dedupe
 *  key: a resumed sub-agent writes a second `task` card for the same
 *  session; admitted on tool call id only if it failed before a session existed. */
export function entryKey(m: SubagentMessage): string | undefined {
  if (m.taskSessionId) return m.taskSessionId;
  return failedSpawn(m) ? m.toolCallId || undefined : undefined;
}

/** How the surviving card is doing, after the dedupe. Always a state,
 *  never undefined: a row leaves the roster only by dismissal. */
export function entryState(m: SubagentMessage): SubagentState {
  if (failedSpawn(m)) return 'failed';
  if (stillOut(m)) {
    // A background card sits at `completed` from the moment it spawns, so its
    // own status can only ever say `queued` before that, never after.
    return status(m) === 'pending' ? 'queued' : 'running';
  }
  // Kept apart from `failed` (the spawn never happened): only that state
  // carries the dismiss control, and a child that ran and errored must be swept up by neither.
  if (m.taskBackground === true) return m.taskDone === 'error' ? 'error' : 'done';
  return status(m) === 'failed' ? 'error' : 'done';
}
