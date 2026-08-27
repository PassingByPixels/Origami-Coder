// WHICH ROW a step takes when the axis is TIME rather than list position.
//
// `run_steps` expands a child's steps inline right after their spawn (engine
// `collect`), so stacking by LIST INDEX draws a background sub-agent's entire
// run above every main-thread turn the user took WHILE it was working. Those
// turns then read as having happened afterwards — the exact opposite of what
// the run recorded. The previous round gave the RAILS that truth
// (labyrinthSpans.ts); this file gives the ROWS the same truth.
//
// The axis is RANK, not elapsed time. A five-minute sub-agent beside a 7ms
// tool call would push a literal time scale off the screen, or squash
// everything else into a single pixel. So each step takes exactly one row and
// the rows are ordered by `startedAt`: order-preserving (a step that started
// earlier is never drawn below one that started later), bounded (the canvas is
// the height it always was), and inventing nothing.
//
// It degrades exactly the way flight does: ONE step without a usable start and
// the WHOLE view falls back to list order, with the pane saying so
// (labyrinthNotice.ts). A part-timed layout would mix recorded positions with
// invented ones, which is worse than admitting the run cannot be clock-ordered.

import { flightIsTimeBased } from './labyrinthFlight';
import { finiteTime, type SpanStep } from './labyrinthSpans';

/**
 * The row each step takes, ordered by `startedAt`; NULL when the run's clock
 * cannot order it and the caller must fall back to list index.
 *
 * The gate is flight's, deliberately: both views answer "can this run be placed
 * by clock?" about the SAME run, and two separate gates could disagree — thread
 * claiming time while the strip denies it. Ties keep list order (a stable
 * tiebreak on index), so equal timestamps degrade to exactly today's rows
 * rather than shuffling steps the clock cannot separate.
 */
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
 * The step sitting on the LAST row — the floor a branch that never returned
 * runs down to. On this axis that is not the last LIST position.
 */
export function lastRowIndex(rows: readonly number[]): number {
  return rows.reduce((best, row, i) => (row > rows[best]! ? i : best), 0);
}

/**
 * Where a branch rejoins the trunk ON THIS AXIS: the LAST ROW whose step
 * started before the branch returned.
 *
 * `mergeIndex` walks the list forward and stops at the first step that started
 * after the branch's `endedAt`. That is right on an index axis, where a later
 * list position is always a later row. Here it is not: a step that ran during
 * the branch may sit anywhere in the list, so the walk stops short and the rail
 * merges ABOVE main-thread work it demonstrably outlived.
 *
 * Never above the branch's own last step: a child whose clock post-dates its
 * parent's return is contradictory data, not a reason to draw backwards.
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
