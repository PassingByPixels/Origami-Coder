// subagentClose.ts — how a passthrough sub-agent's card ends, which on this CLI is three different
// things.
// A foreground `Task` blocks its own tool call, so its result is the child coming home and closing
// the tally.
// An `Agent` launch does not end there: its tool_result returns at once while the child runs on in
// the background, and none of its frames come back tagged for us — so the card reads `completed`
// while the agent is still out (`taskBeat.background` corrects for this, same as
// subagentEntry.stillOut does for the engine's own detached children).
// A background row settles two ways: the `task_notification` system frame (proven by two live
// probes on this CLI's exact spawn recipe), or the child's exit (a killed child sends no
// notification at all). The family's other two frames, `task_started` and `task_updated`, are
// deliberately ignored — the row is already open by the launch result. A turn ending settles
// neither; a background agent outlives turns by design.

import type { ClaudeEvent } from './protocol';
import type { AgentBeat, TranslatorState, WebviewPost } from './cellState';
import { beatRiders } from './subagentBeat';

/** The launch result's own wording, and the id it hands back. Both verbatim
 *  from the captured sessions; the id is 17 lowercase hex-ish characters there,
 *  matched loosely because its width is not part of any contract. */
const LAUNCHED = /Async agent launched/;
const AGENT_ID = /agentId:\s*([A-Za-z0-9]+)/;

/** EVERY field of a system frame is optional. The second probe's `task_updated`
 *  carried no `tool_use_id` at all, so nothing here may assume one is there. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What the exit sweep says happened, since nobody measured an outcome. */
export const EXIT_ENDED = 'interrupted';

/**
 * The parent tool reported its result. For a `Task` the child is home and the tally closes; for an
 *  `Agent` the child has only just started, so this branch emits no `taskEndedAt` and keeps the
 *  tally open — subagentClose's two settle paths take it from here.
 *
 * The launcher test must be `Agent` specifically (a foreground `Task` quoting launch metadata back
 *  must not be marked background), and the text must match too (a failed `Agent` call, with no
 *  child and no agentId, must not strand).
 */
export function closeAgent(
  st: TranslatorState,
  toolCallId: string,
  now: number,
  resultText = '',
): Record<string, unknown> {
  const beat = st.agents.get(toolCallId);
  if (!beat) return {};
  if (beat.tool === 'Agent' && LAUNCHED.test(resultText)) {
    beat.background = true;
    beat.agentId = AGENT_ID.exec(resultText)?.[1] ?? '';
    return beatRiders(beat);
  }
  st.agents.delete(toolCallId);
  return { ...beatRiders(beat), taskEndedAt: now };
}

/**
 * The closing update for one background row. `content` is written, not left absent, because
 *  `chatToolMsg.applyToolResult` replaces the card's result text with whatever the update carries —
 *  leaving it absent would blank the card.
 */
function settled(st: TranslatorState, toolCallId: string, beat: AgentBeat, ended: string, now: number): WebviewPost {
  return {
    type: 'toolResult', sessionId: st.sessionId, toolCallId, status: 'completed',
    content: `Background agent ${ended === EXIT_ENDED ? 'was still out when Claude Code exited' : ended}.`,
    ...beatRiders(beat, ended), taskEndedAt: now,
  };
}

/**
 * The two joins, tried in order: `tool_use_id` is the tally's key directly; `task_id` matches the
 *  agent id the launch handed back, for a frame carrying no tool_use_id. Both refuse a beat that is
 *  not background, and both remove what they find, making a repeat notification a no-op.
 */
function takeByToolUse(st: TranslatorState, toolCallId: string): [string, AgentBeat] | null {
  const beat = toolCallId ? st.agents.get(toolCallId) : undefined;
  if (!beat?.background) return null;
  st.agents.delete(toolCallId);
  return [toolCallId, beat];
}

function takeAgent(st: TranslatorState, agentId: string): [string, AgentBeat] | null {
  if (!agentId) return null;
  for (const [toolCallId, beat] of st.agents) {
    if (beat.background && beat.agentId === agentId) {
      st.agents.delete(toolCallId);
      return [toolCallId, beat];
    }
  }
  return null;
}

/**
 * A `system` frame of the task_* family. `task_notification` settles the row it names; the other
 *  two are ignored (see the file header). An id this cell never launched, or one already settled,
 *  is a no-op.
 */
export function taskSystemPosts(ev: ClaudeEvent, st: TranslatorState, now: number): WebviewPost[] {
  if (ev.subtype !== 'task_notification') return [];
  const found = takeByToolUse(st, str(ev.tool_use_id)) ?? takeAgent(st, str(ev.task_id));
  if (!found) return [];
  return [settled(st, found[0], found[1], str(ev.status) || 'completed', now)];
}

/**
 * Settle every background row this cell still has out. Called from the exit seam only — a turn
 *  close must never call it, since a background agent outlives the turn by design.
 */
export function settleBackgroundAgents(st: TranslatorState, now: number): WebviewPost[] {
  const posts: WebviewPost[] = [];
  for (const [toolCallId, beat] of [...st.agents]) {
    if (!beat.background) continue;
    st.agents.delete(toolCallId);
    posts.push(settled(st, toolCallId, beat, EXIT_ENDED, now));
  }
  return posts;
}
