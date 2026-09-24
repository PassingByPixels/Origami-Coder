// subagentInbox.ts — where a sub-agent's side channel lands: the forwarded
// live chunk, the engine's terminal marker, and what happens when neither
// has a card to land on.
//
// Split by responsibility, matching sibling leaves (roster, rows, format,
// and this one for side-channel events). All four are pure and DOM-free.
//
// Both the chunk and the marker arrive under the parent session tagged
// with a child's id, and both are dropped when no card carries that id.
// Dropping silently would let a whole child's stream vanish unnoticed.

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

/** Per-sub-agent live-stream budget, in characters: a volume guard for a
 *  fan-out, since ten concurrent streams would be ten unbounded buffers.
 *  The tail is kept — the final result arrives separately as the tool result. */
export const SUBAGENT_STREAM_CAP = 8000;

/** The child id carried by a side-channel message, or `''` when it carries
 *  none — an untagged chunk belongs to no card and can only be dropped. */
export function childId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The card of `child`'s CURRENT run, or none. A card carries no session id until
 *  the child session exists, so an early chunk genuinely has nowhere to go.
 *  t-v5qi8q: the NEWEST card, because each resume (`task_id`) writes another card
 *  for the same child and the drawer row reads the newest (subagentRows.ts). The
 *  first card kept every marker, so a resumed child stayed RUNNING for ever. The
 *  host's message log picks newest-first too (sessionLogSubagent.ts). */
export function cardForChild<T extends SubagentCard>(messages: readonly T[], child: string): T | undefined {
  if (!child) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.taskSessionId === child) return messages[i];
  return undefined;
}

/** The terminal marker for `child`, stamped on its card. Returns the card, or
 *  undefined when none carries that id (the caller logs that drop). The first
 *  end wins: the injected turn can re-emit the marker with a later time. */
export function settleChild<T extends SubagentCard>(messages: readonly T[], child: string, state: unknown, endedAt: unknown): T | undefined {
  const card = cardForChild(messages, child);
  if (!card) return undefined;
  card.taskDone = state === 'error' ? 'error' : 'completed';
  if (typeof endedAt === 'number' && card.taskEndedAt === undefined) card.taskEndedAt = endedAt;
  return card;
}

/** `current` plus `text`, keeping the last SUBAGENT_STREAM_CAP characters. */
export function cappedStream(current: string | undefined, text: string): string {
  const next = (current ?? '') + text;
  return next.length > SUBAGENT_STREAM_CAP ? next.slice(-SUBAGENT_STREAM_CAP) : next;
}

/** How many drops of one kind, for one child, pass before another line is
 *  logged — a live sub-agent chunks continuously, so every drop would flood. */
export const DROP_LOG_EVERY = 100;

/**
 * A counter for side-channel events landed on no card; returns the line to
 * log, or `''` when only counting. A factory, not module state, so the
 * count belongs to the pane instance that owns the transcript. The first
 * drop for a child always reports; after that, every `every`-th does.
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
