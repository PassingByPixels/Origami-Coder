// subagentBeat.ts — how many sub-agents this passthrough cell has out, and how busy each is,
// without rendering a word any of them said.
// The CLI streams a child's frames back under the parent session tagged with `parent_tool_use_id`;
// translator.translate drops all of them (rendering would interleave two conversations and
// double-count the context meter). This file counts the dropped frames on the way out instead,
// keyed by the parent `Task`/`Agent` tool_use id, and rides the count on the same `toolResult`
// update the translator already sends for that card.
// Only `assistant` frames move a tally: the CLI also sends every block as `stream_event` deltas and
// as `user` tool-result echoes, and counting those too would double every number.

import type { ClaudeEvent } from './protocol';
import type { AgentBeat, TranslatorState, WebviewPost } from './cellState';

/** Least time between two heartbeat posts for the SAME agent. A child can emit
 *  many frames a second and every post re-renders the transcript; one a second
 *  is the rate the drawer's own clock already ticks at. */
export const BEAT_MS = 1000;

/** The parent `Task` this frame belongs to, or `''` for a main-thread frame.
 *  Mirrors protocol.isSubagentEvent's rule — non-empty string only — because
 *  the two must agree on what a child frame is. */
export function beatParentOf(ev: ClaudeEvent): string {
  const parent = ev.parent_tool_use_id;
  return typeof parent === 'string' ? parent : '';
}

/** How many tools one `assistant` frame started. */
function toolBlocks(ev: ClaudeEvent): number {
  const message = ev.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return 0;
  return (message.content as Array<Record<string, unknown>>).filter((b) => b && b.type === 'tool_use').length;
}

/** The rider the card carries. Counts only — no child text, ever. `background`
 *  and `ended` are the BACKGROUND half (subagentClose.ts) and ride only when
 *  they say something: a foreground Task's rider is unchanged, byte for byte. */
export function beatRiders(beat: AgentBeat, ended = ''): Record<string, unknown> {
  return {
    taskBeat: {
      name: beat.name, tools: beat.tools, msgs: beat.msgs,
      ...(beat.background ? { background: true } : {}),
      ...(ended ? { ended } : {}),
    },
  };
}

/**
 * A `Task` or `Agent` block just went out: open its tally and return the riders to attach to the
 *  update already being sent for that card.
 *
 * Both spawn a child; they differ only in how the row ends (subagentClose.ts), not in whether it
 *  exists. Anything else returns `{}`. Already-open wins, since the CLI can re-send a completed
 *  block and re-registering would reset a running child's counts to zero.
 */
export function openAgent(
  st: TranslatorState,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  if ((toolName !== 'Task' && toolName !== 'Agent') || st.agents.has(toolCallId)) return {};
  // The Task's own `description` is the brief the model wrote for the child, so
  // it is the only thing that tells five concurrent agents apart. A Task with
  // none still gets a row — named, not blank.
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  // The LAUNCHER is remembered because the two end differently, and only this
  // frame knows which one opened the row (subagentClose.closeAgent).
  const beat: AgentBeat = { name: description || 'agent', tools: 0, msgs: 0, startedAt: now, postedAt: now, tool: toolName };
  st.agents.set(toolCallId, beat);
  // `taskStartedAt` is the drawer's own age source (subagentTiming.ts), which
  // otherwise falls back to the instant the CARD was built.
  return { ...beatRiders(beat), taskStartedAt: now };
}

/**
 * One dropped child frame, counted. Returns the heartbeat post, or nothing when this frame changed
 *  no count or the throttle has not elapsed.
 *
 * An unknown parent counts nothing rather than inventing a row. The first change always posts
 *  regardless of the throttle, so a fan-out's rows appear as the work starts.
 */
export function beatPosts(ev: ClaudeEvent, st: TranslatorState, now: number): WebviewPost[] {
  const parent = beatParentOf(ev);
  const beat = st.agents.get(parent);
  if (!beat || ev.type !== 'assistant') return [];
  const first = beat.tools + beat.msgs === 0;
  beat.msgs += 1;
  beat.tools += toolBlocks(ev);
  if (!first && now - beat.postedAt < BEAT_MS) return [];
  beat.postedAt = now;
  // `status: 'in_progress'` deliberately: this update lands on the parent's own
  // card, and the card is still running. Anything else would settle it early.
  return [{ type: 'toolResult', sessionId: st.sessionId, toolCallId: parent, status: 'in_progress', ...beatRiders(beat) }];
}
