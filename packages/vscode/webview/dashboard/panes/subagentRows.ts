// subagentRows.ts — which sub-agents this chat currently has out, derived
// from the transcript it already holds.
//
// A derivation, not a new wire: every fact the drawer needs is already in
// ChatPane's messages — a `task` tool call carries the sub-agent's session id
// and its status moves pending -> in_progress -> completed/failed. A second
// channel reporting the same thing would be a second source of truth, free to
// disagree with the tool card sitting three lines above it.
//
// Pure and DOM-free, with the clock injected, so "is this agent still out, for
// how long?" is testable without rendering. Who belongs on the roster lives in
// subagentEntry.ts; how a row prints in subagentFormat.ts / subagentThinking.ts.

import { activityTail } from './subagentFormat';
import { subagentElapsed } from './subagentTiming';
import { thinkingRow } from './subagentThinking';
import { entryKey, entryState, isSettled, type SubagentState } from './subagentEntry';
import type { SubagentTokens } from './subagentTokens';
import { beatName, beatNote, beatState, passthroughKey, type RosterMessage } from './subagentPassthrough';
import { subagentIdentity, subagentLabel, subagentOrdinals, subagentShort, type SubagentIdentity } from './subagentLabel';

export type { SubagentMessage, SubagentState } from './subagentEntry';
export { subagentLabel, subagentShort }; // a surface that reads rows here NAMES them from here

/** A row carries its IDENTITY (subagentLabel.ts) on top of its lifecycle. */
export interface SubagentRow extends SubagentIdentity {
  /** Dedupe + render identity: the child's session id, else the launcher call id. */
  key: string;
  /** The child's OWN session. Absent when no child was created — exactly when
   *  there is no stream, no cost and no agent to go and look at. */
  taskSessionId?: string;
  title: string;
  state: SubagentState;
  /** A settled total once ended, a live age while out, 0 = no honest start. */
  elapsedMs: number;
  /** Has it stopped? Carried rather than re-derived from `state` in the markup,
   *  so the row that PRINTS the age and the rule that FROZE it read one answer,
   *  and what tells a settled `elapsedMs: 0` (em dash) from a live one (blank). */
  settled: boolean;
  /** `provider/model` the child runs on, when the card carried one. */
  model?: string;
  /** Tail of the child's live output (subagentFormat.ts), '' when silent. */
  activity: string;
  /** t-gvz8t0. `thinking · ~5.4k tokens · 2m 05s` and the last line of thought; both
   *  '' unless reasoning NOW. `activity` is EMPTY all through it — subagentThinking.ts. */
  thinking: string;
  thought: string;
  /** What the child has SPENT, when the engine rode the figure. Absent against
   *  an older engine — every reader treats blank as an answer, not as zero
   *  (subagentTokens.ts). */
  tokens?: SubagentTokens;
  /** Epoch ms the child ENDED — the only date the auto-sweep can retire a
   *  settled row on (subagentRetire.ts). Absent when nobody timed the finish. */
  endedAt?: number;
}

// One shared empty set, so a caller that never dismisses allocates nothing.
const EMPTY_DISMISSED: ReadonlySet<string> = new Set();

/** This chat's sub-agents, oldest first — live and settled. Deduped by key,
 *  keeping the LAST card for each: a resumed sub-agent produces a second `task`
 *  card for the same session and must not list as two agents, and the dedupe
 *  runs before the still-out filter so it is judged on its latest card.
 *  Dismissed keys are the drawer's own retirement, layered on top of
 *  subagentEntry.ts's lifecycle rather than inside it. */
export function subagentRows(
  messages: ReadonlyArray<RosterMessage>,
  now: number,
  dismissedKeys: ReadonlySet<string> = EMPTY_DISMISSED,
): SubagentRow[] {
  const latest = new Map<string, RosterMessage>();
  for (const m of messages) {
    // No child session ⇒ the parent `Task` id (subagentPassthrough.ts).
    const key = entryKey(m) ?? passthroughKey(m);
    if (!key) continue;
    latest.set(key, m);
  }

  // Numbered over the WHOLE transcript, before any dismissal: T2 stays T2 when T1 retires.
  const ordinals = subagentOrdinals(messages);
  const rows: SubagentRow[] = [];
  for (const [key, m] of latest) {
    if (dismissedKeys.has(key)) continue;
    const state = beatState(m) ?? entryState(m); // a BACKGROUND launch's card completes at spawn — subagentPassthrough.ts
    rows.push({
      ...subagentIdentity(m, ordinals.get(key) ?? 0),
      key,
      taskSessionId: m.taskSessionId || undefined,
      // The card's own header, so the drawer and the transcript name one agent.
      // No label falls back to the row key — addressable, never "(sub-agent)".
      title: beatName(m) || (m.label ?? '').trim() || key,
      state,
      elapsedMs: subagentElapsed(m, now, isSettled(state)),
      settled: isSettled(state),
      model: (m.taskModel ?? '').trim() || undefined,
      activity: beatNote(m) || activityTail(m.taskStream),
      ...thinkingRow(m, now, isSettled(state)),
      ...(m.taskTokens ? { tokens: m.taskTokens } : {}),
      ...(m.taskEndedAt ? { endedAt: m.taskEndedAt } : {}),
    });
  }
  return rows;
}

/** The drawer's two groups, both in the oldest-first order above. */
export interface SubagentGroups {
  running: SubagentRow[];
  complete: SubagentRow[];
}

/** Still out vs finished, as a partition rather than two filters: every row lands
 *  in exactly one group, and `complete` is the negative side deliberately, so an
 *  unclassified state shows up there wrong but visible. */
export function groupSubagents(rows: ReadonlyArray<SubagentRow>): SubagentGroups {
  const running: SubagentRow[] = [];
  const complete: SubagentRow[] = [];
  for (const row of rows) (isSettled(row.state) ? complete : running).push(row);
  return { running, complete };
}
