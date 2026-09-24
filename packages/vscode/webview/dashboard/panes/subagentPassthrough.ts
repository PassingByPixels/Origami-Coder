// subagentPassthrough.ts: sub-agents a Claude passthrough cell has out.
// A Claude sub-agent has no child session: the CLI tags its output with
// `parent_tool_use_id`, and the translator drops those frames rather than
// interleave two conversations and double-count the context meter.
// This file keys on the parent's `Task` tool_use id instead: the host
// counts dropped frames by that id (subagentBeat.ts) as `taskBeat`, and
// never touches subagentEntry.ts, so a passthrough row can't offer a
// transcript page that doesn't exist.

import type { SubagentMessage } from './subagentEntry';

/** The tally the host rides on a passthrough `Task` card. Counts reflect
 *  what the child did, never what it said. */
export interface PassthroughBeat {
  name: string;
  tools: number;
  msgs: number;
  /** Set by the `Agent` tool, which returns the instant the child spawns:
   *  the card reads `completed` while the agent is still out. Absent for a foreground `Task`. */
  background?: boolean;
  /** How that background agent ended, once something said so; absent while still out. */
  ended?: string;
}

/** The card slice this file reads. The rider's presence is the marker. */
export interface PassthroughCard {
  taskBeat?: PassthroughBeat;
}

/** A roster message that may carry the rider. */
export type RosterMessage = SubagentMessage & PassthroughCard;

/** What a passthrough row shows in place of live output, stated plainly
 *  since silence and broken look the same. */
export const NO_STREAM_NOTE = 'stream not captured (Claude passthrough)';

/** What a background row shows instead: the launcher finishes at spawn,
 *  so news arrives as a notification rather than the row looking stuck. */
export const BACKGROUND_NOTE = 'background — completion arrives as a notification';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** The wire's untyped `taskBeat`, shaped, or undefined when absent. Shaped
 *  rather than trusted: the restore path replays a logged object, so junk reaches this side too. */
export function passthroughBeat(raw: unknown): PassthroughBeat | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const b = raw as { name?: unknown; tools?: unknown; msgs?: unknown; background?: unknown; ended?: unknown };
  return {
    name: typeof b.name === 'string' ? b.name : '', tools: count(b.tools), msgs: count(b.msgs),
    // Both written only when they say something, so a foreground row's tally
    // is unchanged from before either field existed.
    ...(b.background === true ? { background: true } : {}),
    ...(typeof b.ended === 'string' && b.ended ? { ended: b.ended } : {}),
  };
}

/** A background row's state; undefined for any card this rule doesn't
 *  cover (every foreground one — `entryState` keeps deciding those). The
 *  `Agent` launch returns as soon as the child spawns, so the card reads
 *  `completed` before the agent finishes; `taskEndedAt` is the real marker,
 *  and a non-`completed` ending reads as 'error' for the same reason. */
export function beatState(m: RosterMessage): 'running' | 'done' | 'error' | undefined {
  if (!m.taskBeat?.background) return undefined;
  if (!m.taskEndedAt) return 'running';
  return m.taskBeat.ended && m.taskBeat.ended !== 'completed' ? 'error' : 'done';
}

/** Roster identity for a passthrough card: the parent `Task` tool call
 *  id, tagged onto every dropped child frame. */
export function passthroughKey(m: RosterMessage): string | undefined {
  return m.taskBeat ? m.toolCallId || undefined : undefined;
}

/** The row's name. A `Task` card's own label is the bare tool name, so a
 *  fan-out of five would give five rows all reading "Task"; the model's brief tells them apart. */
export function beatName(m: RosterMessage): string {
  return m.taskBeat ? m.taskBeat.name.trim() : '';
}

/** The row's activity box: how busy this child is, and why there is no stream under it. */
export function beatNote(m: RosterMessage): string {
  const b = m.taskBeat;
  if (!b) return '';
  // A background agent sends nothing back, so "0 tools · 0 messages" would
  // read as an agent doing nothing rather than one nobody can see.
  if (b.background) return b.ended ? `${BACKGROUND_NOTE}\nended: ${b.ended}` : BACKGROUND_NOTE;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(b.tools, 'tool')} · ${plural(b.msgs, 'message')}\n${NO_STREAM_NOTE}`;
}
