// subagentRows.ts — WHICH sub-agents this chat currently has out, derived from
// the transcript it already holds.
//
// WHY A DERIVATION AND NOT A NEW WIRE. Every fact the drawer needs is already
// in ChatPane's messages: a `task` tool call carries the sub-agent's session id
// (`taskSessionId`, from `_meta.origami_task_session`) and its own status moves
// pending -> in_progress -> completed/failed as the child runs. A second
// channel reporting the same thing would be a second source of truth, free to
// disagree with the tool card sitting three lines above it.
//
// Pure and DOM-free, with the clock INJECTED, so "is this agent still out, and
// for how long?" is testable without rendering or waiting. WHO belongs on the
// roster lives in subagentEntry.ts and how a row PRINTS in subagentFormat.ts —
// both split off when this file reached its cap.

import { activityTail } from './subagentFormat';
import { subagentElapsed } from './subagentTiming';
import { entryKey, entryState, type SubagentMessage, type SubagentState } from './subagentEntry';

export type { SubagentMessage, SubagentState } from './subagentEntry';

export interface SubagentRow {
  /** Dedupe and render identity: the child's session id, or — for a spawn that
   *  never created one — the launcher card's tool call id. */
  key: string;
  /** The child's OWN session. Absent when no child was ever created, which is
   *  exactly when there is no stream, no cost and no agent to go and look at. */
  taskSessionId?: string;
  title: string;
  state: SubagentState;
  /** How long the child ran — a settled TOTAL once it has ended, its live age
   *  while it is still out, and 0 (= unknown, printed as nothing) when no
   *  honest start is known. The rules are subagentTiming.ts's. */
  elapsedMs: number;
  /** `provider/model` the child runs on, when the card carried one. */
  model?: string;
  /** Tail of the child's live output (subagentFormat.ts), '' when silent. The
   *  drawer's three-line glance, and the ONLY thing the forwarded stream feeds
   *  now: the full-stream tab it also fed was retired — a transient buffer
   *  cannot answer "what is this agent doing" in a reopened chat, and the
   *  engine's stored transcript can (SubagentDock.svelte). */
  activity: string;
}

// A single shared empty set for the common (no dismissals yet) call, so a
// caller that never dismisses anything allocates nothing per render.
const EMPTY_DISMISSED: ReadonlySet<string> = new Set();

/**
 * This chat's sub-agents, oldest first — the live ones AND the settled ones.
 * Settled rows used to vanish here (`entryState` returned undefined and they
 * were skipped), which is why the drawer could only ever show a Running list.
 *
 * DEDUPED BY KEY, keeping the LAST card for each: the model can resume a
 * sub-agent, which produces a second `task` card for the same session, and
 * listing it twice would say two agents are out when one is. The dedupe runs
 * BEFORE the still-out filter, so a resumed agent is judged on its latest card
 * rather than kept alive by an earlier one.
 *
 * DISMISSED KEYS are the drawer's own retirement, layered on top of
 * subagentEntry.ts's lifecycle rather than inside it: a failed spawn is
 * PERMANENTLY 'failed' by that file's own rule (a refused ask is a fact about
 * the chat, never settling on its own), so "stop showing it" has to be a
 * separate, explicit removal — never mistaken for the card itself changing
 * state. A dismissed key that later reappears (it cannot, per that same rule:
 * a failed spawn's tool-call id is never reused) would simply stay hidden.
 */
export function subagentRows(
  messages: ReadonlyArray<SubagentMessage>,
  now: number,
  dismissedKeys: ReadonlySet<string> = EMPTY_DISMISSED,
): SubagentRow[] {
  const latest = new Map<string, SubagentMessage>();
  for (const m of messages) {
    const key = entryKey(m);
    if (!key) continue;
    latest.set(key, m);
  }

  const rows: SubagentRow[] = [];
  for (const [key, m] of latest) {
    if (dismissedKeys.has(key)) continue;
    const state = entryState(m);
    rows.push({
      key,
      taskSessionId: m.taskSessionId || undefined,
      // The card's own header, so the drawer and the transcript name the same
      // agent. A card with no label falls back to the row key, which is at
      // least addressable — never to a placeholder like "(sub-agent)".
      title: (m.label ?? '').trim() || key,
      state,
      elapsedMs: subagentElapsed(m, now),
      model: (m.taskModel ?? '').trim() || undefined,
      activity: activityTail(m.taskStream),
    });
  }
  return rows;
}

/** The drawer's two groups, both in the oldest-first order above. */
export interface SubagentGroups {
  running: SubagentRow[];
  complete: SubagentRow[];
}

/**
 * Still out vs finished, as a PARTITION rather than two filters: every row
 * lands in exactly one group, so a state added later cannot be dropped by
 * both. `complete` is the negative side deliberately — an unclassified state
 * then shows up under Complete, which is wrong but VISIBLE.
 */
export function groupSubagents(rows: ReadonlyArray<SubagentRow>): SubagentGroups {
  const running: SubagentRow[] = [];
  const complete: SubagentRow[] = [];
  for (const row of rows) (row.state === 'running' || row.state === 'queued' ? running : complete).push(row);
  return { running, complete };
}
