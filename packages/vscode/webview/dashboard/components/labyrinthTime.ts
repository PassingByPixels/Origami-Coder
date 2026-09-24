// WHICH ROW a step takes when the axis is TIME rather than list position.
//
// `run_steps` expands a child's steps inline right after spawn, so
// stacking by list index draws a background sub-agent's whole run above
// main-thread turns that happened WHILE it worked — the opposite of what
// the run recorded. labyrinthSpans.ts gives the RAILS that truth; this
// file gives the ROWS the same truth.
//
// The axis is RANK, not elapsed time, so a five-minute sub-agent can't
// push a tool call off the screen: each step takes one row, ordered by
// `startedAt`.
//
// It degrades exactly the way flight does: one step without a usable
// start falls the whole view back to list order, with the pane saying so.

import { flightIsTimeBased } from './labyrinthFlight';
import { finiteTime, type SpanStep } from './labyrinthSpans';

/** The row each step takes, ordered by `startedAt`; NULL when the run's
 *  clock cannot order it. The gate is flight's, deliberately: both views
 *  answer the same "can this run be placed by clock?" question. Ties
 *  keep list order (a stable tiebreak on index). */
export function threadRows(steps: readonly SpanStep[]): number[] | null {
  if (!flightIsTimeBased(steps)) return null;
  const at = steps.map((s) => finiteTime(s.startedAt) as number);
  const order = steps.map((_, i) => i).sort((a, b) => at[a]! - at[b]! || a - b);
  const rows = new Array<number>(steps.length);
  order.forEach((index, row) => { rows[index] = row; });
  return rows;
}

/** True when thread's rows are ordered by clock rather than by list position. */
export function threadIsTimeBased(steps: readonly SpanStep[]): boolean {
  return threadRows(steps) !== null;
}

/**
 * The step sitting on the LAST row — the floor a branch that never
 * returned runs down to. Not the last LIST position on this axis.
 */
export function lastRowIndex(rows: readonly number[]): number {
  return rows.reduce((best, row, i) => (row > rows[best]! ? i : best), 0);
}

/**
 * Where a branch rejoins the trunk on this axis: the LAST ROW whose step
 * started before the branch returned.
 *
 * On an index axis, a later list position is always a later row, so the
 * walk can stop at the first step after `endedAt`. Here it can't: a step
 * that ran during the branch may sit anywhere in the list, so the merge
 * point is never above the branch's own last step.
 */
export function rowMergeIndex(
  steps: readonly SpanStep[],
  rows: readonly number[],
  first: number,
  last: number,
): number {
  const head = steps[first];
  const end = head?.kind === 'subagent' ? finiteTime(head.endedAt) : undefined;
  if (end === undefined) return last;
  let at = last;
  steps.forEach((s, i) => {
    if (finiteTime(s.startedAt)! < end && rows[i]! > rows[at]!) at = i;
  });
  return at;
}
