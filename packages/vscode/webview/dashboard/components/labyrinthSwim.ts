// FLIGHT AS A SWIMLANE BOARD — the reviewed run along one horizontal spine and
// a LANE PER SUB-AGENT below it, each starting where it was spawned and ending
// where it really reported back.
//
// The lane a branch takes is NOT a second model: it is exactly the column
// labyrinthBranches.ts already allocates for thread, read on a horizontal axis.
// That ledger already releases a column the moment its branch merges (so 25
// sequential sub-agents share ONE lane) and folds overflow onto the outermost
// column (so a deep run cannot walk off the canvas). A second allocator here
// would let the two views disagree about the same run.
//
// CONCURRENCY IS THE POINT. Thread has to stagger overlapping branches down
// separate rows to keep them legible; here two sub-agents that genuinely ran in
// the same minute cover the SAME stretch of x on two different lanes. This is
// the one view where that overlap is honest, so it is not suppressed.
//
// Everything carrying a LENGTH stays gated on the clock, exactly as before. On
// the evenly-spaced fallback the lanes still separate the sub-agents (which is
// a fact about the run, not about time) but no bar, departure or rejoin is
// drawn, because their extent would be invention — and the pane says so
// (labyrinthNotice.ts).

import { branchModel, type BranchStep } from './labyrinthBranches';
import { MAX_MEMBER_LANES, memberLanes } from './labyrinthCollabIndex';
import { DETAIL_CHARS } from './labyrinthDetail';
import {
  flightBox, flightLayout, flightTimeScale,
  FLIGHT_BASE_Y, FLIGHT_CLOCK_Y, FLIGHT_LANE_DY,
} from './labyrinthFlight';
import { finiteTime } from './labyrinthSpans';

/** The part of a step the swimlane model reads. `LayoutStep` satisfies it. */
export type SwimStep = BranchStep & { agent?: string };

/**
 * Pitch from one sub-agent lane to the next. Sized to clear a whole detail
 * block (caption plus up to five rows), not merely the marker: a lane whose
 * rows land on its neighbour's is less readable than no detail at all.
 */
export const SWIM_LANE_DY = 118;
/** Over-estimated advance for the 10px detail rows (mirrors THREAD_CHAR_W). */
const DETAIL_CHAR_W = 6.2;

/**
 * y of sub-agent lane `column`. Lane 0 IS the strip's old single delegation
 * row, so a run with one sub-agent is drawn exactly where it always was.
 */
export function swimLaneY(column: number): number {
  return FLIGHT_BASE_Y + FLIGHT_LANE_DY + Math.max(0, column) * SWIM_LANE_DY;
}

/**
 * How many lanes a run opens; 0 when it delegated nothing. On a collab map the
 * count is the ROSTER's, not the drawn steps' - a member that never started
 * keeps its lane so the labels stay aligned with the lanes under them.
 */
export function swimLaneCount(steps: readonly SwimStep[], members?: readonly string[]): number {
  if (members?.length) return Math.min(memberLanes(steps, members).names.length, MAX_MEMBER_LANES);
  return branchModel(steps).column.reduce((n, c) => Math.max(n, c + 1), 0);
}

/** Flight's canvas: the strip's own width, plus a row per EXTRA lane. */
export function swimBox(count: number, lanes: number): { width: number; height: number } {
  const box = flightBox(count);
  return { width: box.width, height: box.height + Math.max(0, lanes - 1) * SWIM_LANE_DY };
}

/** The clock row, kept under the LOWEST lane actually in use. */
export function swimClockY(lanes: number): number {
  return FLIGHT_CLOCK_Y + Math.max(0, lanes - 1) * SWIM_LANE_DY;
}

/**
 * Named rows for the delegation half of the strip, one per open lane.
 *
 * `names` is the collab member roster, in lane order. With it a lane says WHO
 * ran on it instead of `SUB-AGENT n`; a lane the roster does not reach keeps
 * the ordinal label rather than borrowing a neighbour's name.
 */
export function swimLaneTags(lanes: number, names?: readonly string[]): Array<{ label: string; y: number }> {
  return Array.from({ length: Math.max(1, lanes) }, (_, c) => ({
    label: names?.[c] || (lanes > 1 ? `SUB-AGENT ${c + 1}` : 'DELEGATION'),
    y: swimLaneY(c),
  }));
}

/**
 * Flight's points: x off the time axis exactly as before, y on the step's OWN
 * lane rather than one shared delegation row. A trunk step keeps the lane the
 * strip always gave it — tools above the spine, main on it.
 *
 * A MERGED COLLAB map takes its lanes from the roster instead of the branch
 * ledger, which cannot express parallel root sessions (labyrinthCollabIndex.ts).
 * `members` rides only on a collab payload, so an ordinary run is untouched.
 */
export function swimLayout<S extends SwimStep>(
  steps: readonly S[],
  members?: readonly string[],
): Array<{ x: number; y: number; step: S }> {
  const column = members?.length ? memberLanes(steps, members).lane : branchModel(steps).column;
  return flightLayout(steps).map((p, i) => (column[i]! < 0 ? p : { ...p, y: swimLaneY(column[i]!) }));
}

export interface FlightSpan {
  /** Render key — the spawning step's index. */
  index: number;
  x1: number;
  x2: number;
  y: number;
  open: boolean;
  background?: boolean;
  /** Leaves the line it was spawned from, down onto its own lane. */
  depart: string;
  /** Returns to that line where it reported back; NULL when it never did. */
  rejoin: string | null;
}

const r = (n: number): number => Math.round(n * 100) / 100;

/**
 * Each sub-agent's LANE: the wall-clock stretch it really ran for, plus the
 * departure and rejoin that make it read as a thread leaving the main line and
 * coming back, rather than as a bar floating underneath it.
 *
 * The extent is the SPAN's, never the child's last step. `run_steps` inlines a
 * child's steps directly after its spawn, so for a detached run the last
 * visible step says nothing about when it returned; `endedAt` does.
 *
 * Drawn only when the strip is genuinely time-based. A run that never came back
 * has NO rejoin — it runs to the axis end and stops open, which is the fact.
 */
export function flightSpans(steps: readonly SwimStep[], members?: readonly string[]): FlightSpan[] {
  // A collab map has NO spawns to draw: its members are root sessions nobody
  // delegated to. The ledger still yields a span for the depth it was handed,
  // and that bar would assert a delegation that never happened.
  if (members?.length) return [];
  const scale = flightTimeScale(steps);
  if (!scale) return [];
  const points = swimLayout(steps);
  const axisEnd = scale(Number.POSITIVE_INFINITY);
  const out: FlightSpan[] = [];
  for (const span of branchModel(steps).spans) {
    const head = steps[span.first];
    // A branch synthesised from a bare `depth` has no spawn and so no clock:
    // its steps still take a lane, but it gets no extent the run never recorded.
    if (head?.kind !== 'subagent') continue;
    const end = finiteTime(head.endedAt);
    if (!span.open && end === undefined) continue;
    const x1 = points[span.first]!.x;
    const x2 = span.open ? axisEnd : scale(end!);
    if (x2 <= x1) continue; // it began and ended in one position: nothing to draw
    const y = swimLaneY(span.column);
    const from = span.parentColumn < 0 ? FLIGHT_BASE_Y : swimLaneY(span.parentColumn);
    out.push({
      index: span.first, x1, x2, y, open: span.open,
      ...(span.background === undefined ? {} : { background: span.background }),
      depart: `M ${r(x1)} ${r(from)} L ${r(x1)} ${r(y)}`,
      rejoin: span.open ? null : `M ${r(x2)} ${r(y)} L ${r(x2)} ${r(from)}`,
    });
  }
  return out;
}

/**
 * Which steps must DROP their detail block. x here is real time, so two steps
 * milliseconds apart land on top of each other and printing both blocks smears
 * them into nonsense. Flight is the detail view, but unreadable detail is worse
 * than none — the caption, the hover title and the inspector still carry it.
 */
export function swimCrowded(points: readonly { x: number; y: number }[]): boolean[] {
  const width = DETAIL_CHARS * DETAIL_CHAR_W;
  return points.map((p, i) =>
    points.some((q, j) => j !== i && q.y === p.y && Math.abs(q.x - p.x) < width));
}
