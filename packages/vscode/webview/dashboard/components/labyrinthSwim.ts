// Flight as a swimlane board: the reviewed run on one horizontal spine, with
// a lane per sub-agent below it, from where it was spawned to where it
// reported back. The lane a branch takes is the same column
// labyrinthBranches.ts allocates for thread, read on a horizontal axis, so
// the two views cannot disagree.
//
// Concurrency is honest here: two sub-agents that ran in the same minute
// cover the same stretch of x on two different lanes, not staggered apart.
// Length stays gated on the clock — on the evenly-spaced fallback, lanes
// still separate sub-agents, but no bar, departure or rejoin is drawn, since
// their extent would be invention (labyrinthNotice.ts).

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

/** Pitch from one sub-agent lane to the next, sized to clear a whole detail
 *  block — a lane landing on its neighbour's rows is worse than no detail. */
export const SWIM_LANE_DY = 118;
const DETAIL_CHAR_W = 6.2; // over-estimated advance for the 10px detail rows

/** y of sub-agent lane `column`; lane 0 is the strip's old single row. */
export function swimLaneY(column: number): number {
  return FLIGHT_BASE_Y + FLIGHT_LANE_DY + Math.max(0, column) * SWIM_LANE_DY;
}

/** How many lanes a run opens, 0 if it delegated nothing. On a collab map
 *  the count is the roster's, so a member that never started keeps its lane. */
export function swimLaneCount(steps: readonly SwimStep[], members?: readonly string[]): number {
  if (members?.length) return Math.min(memberLanes(steps, members).names.length, MAX_MEMBER_LANES);
  return branchModel(steps).column.reduce((n, c) => Math.max(n, c + 1), 0);
}

/** Flight's canvas: the strip's own width, plus a row per extra lane. */
export function swimBox(count: number, lanes: number): { width: number; height: number } {
  const box = flightBox(count);
  return { width: box.width, height: box.height + Math.max(0, lanes - 1) * SWIM_LANE_DY };
}

/** The clock row, kept under the LOWEST lane actually in use. */
export function swimClockY(lanes: number): number {
  return FLIGHT_CLOCK_Y + Math.max(0, lanes - 1) * SWIM_LANE_DY;
}

/** Named rows for the delegation half of the strip, one per open lane.
 *  `names` is the roster in lane order; a lane the roster doesn't reach
 *  keeps its ordinal label instead of borrowing a neighbour's name. */
export function swimLaneTags(lanes: number, names?: readonly string[]): Array<{ label: string; y: number }> {
  return Array.from({ length: Math.max(1, lanes) }, (_, c) => ({
    label: names?.[c] || (lanes > 1 ? `SUB-AGENT ${c + 1}` : 'DELEGATION'),
    y: swimLaneY(c),
  }));
}

/** Flight's points: x off the time axis, y on the step's own lane. A collab
 *  map takes lanes from the roster instead of the branch ledger. */
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

/** Each sub-agent's lane: the wall-clock stretch it ran, plus depart/rejoin
 *  paths to the main line. Extent comes from the span, not the child's last
 *  step — only `endedAt` says when a run actually returned. */
export function flightSpans(steps: readonly SwimStep[], members?: readonly string[]): FlightSpan[] {
  // A collab map has no spawns to draw: its members are root sessions, and a
  // ledger-yielded span would assert a delegation that never happened.
  if (members?.length) return [];
  const scale = flightTimeScale(steps);
  if (!scale) return [];
  const points = swimLayout(steps);
  const axisEnd = scale(Number.POSITIVE_INFINITY);
  const out: FlightSpan[] = [];
  for (const span of branchModel(steps).spans) {
    const head = steps[span.first];
    // A branch synthesised from a bare `depth` has no spawn and so no clock.
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

/** Which steps must drop their detail block: x is real time, so points
 *  milliseconds apart would smear together if both printed detail. */
export function swimCrowded(points: readonly { x: number; y: number }[]): boolean[] {
  const width = DETAIL_CHARS * DETAIL_CHAR_W;
  return points.map((p, i) =>
    points.some((q, j) => j !== i && q.y === p.y && Math.abs(q.x - p.x) < width));
}
