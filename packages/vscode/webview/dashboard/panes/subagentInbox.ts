// subagentInbox.ts — where a sub-agent's SIDE CHANNEL lands: the forwarded
// live chunk, the engine's terminal marker, and what happens when neither has
// a card to land on.
//
// EXTRACTED from ChatPane.svelte, which was at 2700/2700 when the drawer's
// clock needed room. The split is by responsibility, matching the sibling
// leaves: subagentEntry.ts decides WHO is on the roster, subagentRows.ts what
// the drawer SHOWS, subagentFormat.ts how a row PRINTS — and this one where a
// side-channel event GOES. All four are pure and DOM-free, so the rules can be
// checked without a render.
//
// The channel is real but invisible: both the chunk and the marker arrive under
// the PARENT session tagged with a child's id, and both are dropped when no
// card carries that id (a chunk that beat its own tool_call, a replayed
// session). Dropping is right — a sub-agent's raw working notes do not belong
// loose in the transcript — but dropping SILENTLY is how a whole child's stream
// goes missing with nothing to show for it.

import type { SubagentSpan } from './subagentTiming';

/** The subset of ChatPane's `Message` this reads. Structural on purpose: the
 *  pane's own interface carries thirty fields this has no business knowing. */
export interface SubagentCard extends SubagentSpan {
  /** The child session this `task` card spawned. */
  taskSessionId?: string;
  /** The child's live output, tail-capped at SUBAGENT_STREAM_CAP. */
  taskStream?: string;
  /** The engine's terminal marker for a detached child. */
  taskDone?: 'completed' | 'error';
}

/**
 * Per-sub-agent live-stream budget, in characters. VOLUME GUARD for a fan-out:
 * ten sub-agents streaming concurrently is ten unbounded buffers otherwise. The
 * TAIL is kept (what it is doing NOW is the point of a live stream) and the
 * final result arrives separately as the tool result, so nothing load-bearing
 * is lost by dropping the head.
 */
export const SUBAGENT_STREAM_CAP = 8000;

/** The child id carried by a side-channel message, or `''` when it carries
 *  none — an untagged chunk belongs to no card and can only be dropped. */
export function childId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The card that spawned `child`, or none. A card carries no session id until
 *  the child session exists, so an early chunk genuinely has nowhere to go. */
export function cardForChild<T extends SubagentCard>(messages: readonly T[], child: string): T | undefined {
  if (!child) return undefined;
  return messages.find((m) => m.taskSessionId === child);
}

/** `current` plus `text`, keeping the last SUBAGENT_STREAM_CAP characters. */
export function cappedStream(current: string | undefined, text: string): string {
  const next = (current ?? '') + text;
  return next.length > SUBAGENT_STREAM_CAP ? next.slice(-SUBAGENT_STREAM_CAP) : next;
}

/** How many drops of one kind, for one child, pass before another line is
 *  logged. A live sub-agent chunks continuously, so one line each would be the
 *  flood; a count that never surfaces is the silence this exists to end. */
export const DROP_LOG_EVERY = 100;

/**
 * A counter for side-channel events that landed on no card, returning the line
 * to log or `''` when this one is only being counted.
 *
 * A FACTORY, not module state: the count belongs to the pane instance that
 * owns the transcript, and a test that had to reset a module-level map would be
 * testing the reset. The first drop of a kind for a child always reports (that
 * is the one saying a whole child's output is going nowhere); after it, every
 * DROP_LOG_EVERY-th carries the running total.
 */
export function makeDropLog(every: number = DROP_LOG_EVERY): (kind: string, child: string) => string {
  const counts = new Map<string, number>();
  return (kind, child) => {
    const key = `${kind}:${child}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count !== 1 && count % every !== 0) return '';
    return `[origami] dropped sub-agent ${kind} for unknown child ${child || '(untagged)'} (${count} so far)`;
  };
}
