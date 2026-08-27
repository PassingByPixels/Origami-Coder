// subagentEntry.ts — the roster ADMISSION rules: which of this chat's messages
// are sub-agents, what identity each has, and how it is doing.
//
// EXTRACTED from subagentRows.ts when the failed-spawn rule took that file to
// its cap. The split is by responsibility, not to move a number: this file
// decides WHO belongs on the roster (lifecycle rules that have to be right — a
// row wrongly retired is an agent nobody is watching), subagentRows.ts decides
// what the drawer shows for the survivors (dedupe, order, shape). DOM-free.

import type { SubagentSpan } from './subagentTiming';

/** The subset of ChatPane's `Message` this reads (run span: subagentTiming.ts).
 *  Structural — the pane's own carries thirty fields this must not know. */
export interface SubagentMessage extends SubagentSpan {
  taskSessionId?: string;
  /** The tool card's header, e.g. `task` or the sub-agent's brief. */
  label?: string;
  toolStatus?: string;
  /** Epoch ms the card was BUILT = the RELOAD instant in a reopened chat, so
   *  subagentTiming.ts reaches for it LAST. */
  timestamp?: number;
  /** The child was DETACHED (`_meta.origami_task_background`). */
  taskBackground?: boolean;
  /** `provider/model` the child was routed to. */
  taskModel?: string;
  /** The engine's terminal marker for a detached child. */
  taskDone?: 'completed' | 'error';
  /** The child's live output, tail-capped by the pane. */
  taskStream?: string;
  /** `_meta.origami_tool_name`. Only a `task` card can be a sub-agent at all —
   *  the same literal ToolCard.svelte already dispatches its task renderer on. */
  toolName?: string;
  /** The launcher card's ACP tool-call id — the ONLY identity a spawn that
   *  never reached a child session will ever have. */
  toolCallId?: string;
}

/** `queued` = the ACP `pending` status (accepted, not started). `failed` = the
 *  spawn itself never happened, so no agent was ever out. `done` / `error` are
 *  the two ways a child that DID run ends. */
export type SubagentState = 'running' | 'queued' | 'failed' | 'done' | 'error';

/**
 * ACP's terminal tool states. Listed as what ENDS a run rather than as what
 * continues one, so a status this build has never seen is treated as still
 * out — an agent wrongly listed as running is a visible, correctable
 * annoyance; one silently dropped from the drawer is a run nobody is watching.
 */
const TERMINAL = new Set(['completed', 'failed']);

const status = (m: SubagentMessage) => (m.toolStatus ?? '').trim();

/**
 * A spawn that NEVER HAPPENED: a `task` call whose permission the user denied,
 * or one naming an agent type that does not exist. Both fail in the engine
 * (src/tool/task.ts) BEFORE a child session is created, so there is no session
 * id for the engine to stamp on the card and no child for the drawer to watch.
 *
 * It is listed rather than dropped because the drawer's whole job is to say
 * what this chat asked for: a fan-out of five with one denied showed four rows
 * and no hint that a fifth was ever attempted. The row is permanent, like the
 * red card in the transcript it is read from — a refused spawn is a fact about
 * the chat, not a state that later settles.
 */
function failedSpawn(m: SubagentMessage): boolean {
  return !m.taskSessionId && m.toolName === 'task' && status(m) === 'failed';
}

/**
 * Is this sub-agent still out?
 *
 * A FOREGROUND call blocks its own tool call until the child returns, so the
 * card's status IS the child's life: terminal status, gone from the drawer.
 *
 * A BACKGROUND call returns the instant the child is spawned — the extension
 * always launches the engine with background sub-agents on, so this is the
 * ordinary case — and its card reaches `completed` moments later while the
 * child works on for minutes. Retiring on that status is what made a fan-out's
 * rows vanish while every agent was still running. Such a row therefore ends
 * ONLY on the engine's terminal marker (`taskDone`), which rides the injected
 * result turn.
 */
function stillOut(m: SubagentMessage): boolean {
  if (m.taskBackground === true) return !m.taskDone;
  return !TERMINAL.has(status(m));
}

/**
 * Which roster row this message belongs to, or none at all.
 *
 * The DEDUPE key as well as the render key: the model can resume a sub-agent,
 * which writes a second `task` card for the same session, and listing it twice
 * would say two agents are out when one is.
 *
 * A card carries no session id until the child session exists, so every spawn
 * looks anonymous for a moment. Only a card that FAILED that way is admitted
 * on its tool call id — an in-flight one is left alone rather than given a row
 * under a key that is about to change.
 */
export function entryKey(m: SubagentMessage): string | undefined {
  if (m.taskSessionId) return m.taskSessionId;
  return failedSpawn(m) ? m.toolCallId || undefined : undefined;
}

/**
 * How the surviving card is doing. Applied AFTER the dedupe — see
 * `subagentRows`.
 *
 * ALWAYS a state, never undefined. It used to go blank the moment an agent
 * settled, and `subagentRows` dropped every row without one — so a FINISHED
 * sub-agent had no row at all and the drawer's Complete group had nothing to
 * hold. Widened by owner decision when that group landed: a row now leaves the
 * roster by DISMISSAL, never by fading out of the derivation.
 */
export function entryState(m: SubagentMessage): SubagentState {
  if (failedSpawn(m)) return 'failed';
  if (stillOut(m)) {
    // A background card sits at `completed` from the moment it spawns, so its
    // OWN status can only ever say `queued` before that — never after.
    return status(m) === 'pending' ? 'queued' : 'running';
  }
  // HOW it ended, off the same two sources `stillOut` just read to decide THAT
  // it ended. Kept apart from `failed` (the spawn never happened): only that
  // state carries the row's dismiss control and the pane's auto-dismiss at the
  // next turn's start, and a child that ran and errored must be swept up by
  // neither.
  if (m.taskBackground === true) return m.taskDone === 'error' ? 'error' : 'done';
  return status(m) === 'failed' ? 'error' : 'done';
}
