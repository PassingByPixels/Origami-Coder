// Labyrinth map geometry — Thread / Corridor / Flight as PURE functions over a
// step list, so the layouts are answerable without a DOM; LabyrinthMap.svelte is
// then only markup over these points.
//
// The step shape is declared here rather than imported from `src/acpExtTypes.ts`
// because tsconfig.webview.json pins rootDir to `webview/`. It MIRRORS `RunStep`
// there (same optional fields); keep the two in step.

import { laneOffset, type CompactionFacts, type LaneStep } from './labyrinthLanes';
import { branchModel } from './labyrinthBranches';
import { branchPaths, branchX, type BranchPath } from './labyrinthRails';
import { swimBox, swimLayout } from './labyrinthSwim';
import { minimapLayout, MINIMAP_HEIGHT, MINIMAP_WIDTH } from './labyrinthMinimap';
import { threadRows } from './labyrinthTime';
import type { CacheFacts } from './labyrinthUsage';

export interface LayoutStep extends LaneStep {
  ordinal: number;
  tool?: string;
  title: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** `reasoning`/`cache` are OPTIONAL: an absent one renders nothing, never 0. */
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read?: number; write?: number } };
  /** The message's own cost; a genuine 0 is a measurement and is kept. */
  cost?: number;
  /** ENGINE-recorded cache facts (0.4.160+) — see `CacheFacts` in labyrinthUsage.ts. */
  cache?: CacheFacts;
  /** OPTIONAL — the owning message recorded NO usage, so a total spanning it is a floor. */
  usageMissing?: true;
  model?: string;
  agent?: string;
  preview?: string;
  error?: string;
  /** OPTIONAL `ordinal` of the subagent step that spawned this one; see LaneStep.depth. */
  parentOrdinal?: number;
  /** OPTIONAL — true when this subagent DETACHED and ran concurrently with the steps
   *  after it. Absent means "this build did not say", never "foreground". */
  background?: boolean;
  /** OPTIONAL session the subagent ran in — links a spawn to its own run. */
  childSessionId?: string;
  /** OPTIONAL - a Flock coordination call (ask/handoff/done/task_*), not ordinary work. */
  collabTool?: boolean;
  /** OPTIONAL - a `[Collab: ...]` envelope the runner posted, NOT a human prompt. */
  baton?: boolean;
  /** OPTIONAL - only on a `compaction` step; see labyrinthLanes.ts. */
  compaction?: CompactionFacts;
}

// Lane assignment, thresholds and tone live in labyrinthLanes.ts; re-exported here.
export { laneFor, laneOffset, isThreshold, stepGlyph, LANE_GAP, normDepth } from './labyrinthLanes';
export type { CompactionFacts, Lane, LaneStep } from './labyrinthLanes';
export { branchModel, MAX_BRANCH_COLUMNS } from './labyrinthBranches';
export type { BranchModel, BranchSpan } from './labyrinthBranches';
// Rails: the drawn extent of a delegated run down a thread column.
export { branchX, branchPaths } from './labyrinthRails';
export type { BranchPath } from './labyrinthRails';
// The timing truth those are drawn from — when a sub-agent really ran.
export { spanIsOpen, spanBackground, mergeIndex, finiteTime } from './labyrinthSpans';
export type { SpanStep } from './labyrinthSpans';
// The vertical axis thread reads its rows off — the clock, or list order.
export { threadRows, threadIsTimeBased, rowMergeIndex } from './labyrinthTime';
export { flightDetail, DETAIL_CHARS } from './labyrinthDetail';
// What the run SPENT — never a fabricated 0, never a short sum shown as complete.
export { usageBreakdown, stepUsageText, formatTokenCount, formatCost } from './labyrinthUsage';
export type { UsageStep, UsageTotal, UsageBreakdown, BranchUsage, AgentUsage, CacheCause, CacheFacts } from './labyrinthUsage';

export type MapMode = 'thread' | 'corridor' | 'flight';

export interface LayoutPoint {
  x: number;
  y: number;
  step: LayoutStep;
}

// --- Thread: the reading view. One trunk, delegated stretches branching left.
export const THREAD_SPINE_X = 260;
const THREAD_TOP = 36;
// Row pitch is set by the label size, not the marker size: 13px captions need it.
export const THREAD_ROW = 46;
const THREAD_WIDTH = 940;
/** Ordinal+duration, offset from the step's OWN marker rather than a left gutter. */
export const THREAD_META_DX = 34;
/** Caption column, left-anchored, clear of the tools lane, its glyph and the meta. */
export const THREAD_LABEL_X = 500;
/**
 * Label budget in characters, derived from the space actually left with an
 * OVER-estimated monospace advance: the SVG viewport clips silently, so landing
 * short is the only safe direction to be wrong in.
 */
const THREAD_CHAR_W = 8.4;
export const THREAD_LABEL_CHARS = Math.floor((THREAD_WIDTH - THREAD_LABEL_X - 12) / THREAD_CHAR_W);

/**
 * Markers down one trunk. A step on a branch takes its branch's COLUMN;
 * everything else takes its lane offset — branches move x, never y. The ROW is
 * the clock's (labyrinthTime.ts) by rank, not elapsed time, so the pitch stays
 * uniform; it falls back to list index when any step's start is missing.
 */
export function threadLayout(steps: readonly LayoutStep[]): LayoutPoint[] {
  const model = branchModel(steps);
  const rows = threadRows(steps);
  return steps.map((step, i) => ({
    x: model.column[i]! >= 0 ? branchX(THREAD_SPINE_X, model.column[i]!) : THREAD_SPINE_X + laneOffset(step),
    y: THREAD_TOP + (rows ? rows[i]! : i) * THREAD_ROW,
    step,
  }));
}

/** The branch rails for a thread layout, over the same points the markers use. */
export function threadBranchPaths(steps: readonly LayoutStep[]): BranchPath[] {
  return branchPaths(threadLayout(steps), branchModel(steps), THREAD_SPINE_X, THREAD_ROW);
}

// --- Corridor: the minimap. The whole run on one screen, density instead of labels.
// A boustrophedon snake (row 0 left->right, row 1 right->left) whose pitch is derived
// from the step count against a fixed canvas. Geometry lives in labyrinthMinimap.ts.
export { minimapLayout, MINIMAP_WIDTH, MINIMAP_HEIGHT } from './labyrinthMinimap';
export type { Minimap, MinimapPoint, MinimapChamber, MinimapStep } from './labyrinthMinimap';

/** Corridor's points in the shared shape, for `layoutFor` and its own tests. */
export function corridorLayout(steps: readonly LayoutStep[]): LayoutPoint[] {
  return minimapLayout(steps).points.map((p) => ({ x: p.x, y: p.y, step: p.step }));
}

// The flight strip's geometry lives in labyrinthFlight.ts; re-exported here.
export {
  flightLayout, flightIsTimeBased, flightTimeScale, FLIGHT_BASE_Y, FLIGHT_LANE_DY, FLIGHT_CLOCK_Y,
  FLIGHT_CAPTION_DY, FLIGHT_DETAIL_DY, FLIGHT_DETAIL_ROW, FLIGHT_CAPTION_CHARS,
} from './labyrinthFlight';
// ...and its SWIMLANES — a lane per sub-agent, off the same branch-column ledger.
export {
  swimLayout, swimBox, swimLaneY, swimLaneCount, swimLaneTags, swimClockY, swimCrowded,
  flightSpans, SWIM_LANE_DY,
} from './labyrinthSwim';
export type { FlightSpan, SwimStep } from './labyrinthSwim';
// ...and the rules that keep the strip's LABELS off each other.
export { swimCaptionHidden, swimClockHidden } from './labyrinthCaptions';

export function layoutFor(mode: MapMode, steps: readonly LayoutStep[]): LayoutPoint[] {
  if (mode === 'corridor') return corridorLayout(steps);
  if (mode === 'flight') return swimLayout(steps);
  return threadLayout(steps);
}

/**
 * The viewBox the mode needs for `count` steps. Thread and flight GROW with the run
 * (the pane scrolls) rather than squash it; corridor is FIXED and shrinks its markers
 * instead, because "the whole run at once" is the one thing neither other mode gives.
 *
 * `lanes` is flight's only: how many sub-agent swimlanes the run opened.
 */
export function viewBoxFor(mode: MapMode, count: number, lanes = 0): { width: number; height: number } {
  if (mode === 'corridor') return { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT };
  if (mode === 'flight') return swimBox(count, lanes);
  return { width: THREAD_WIDTH, height: Math.max(180, THREAD_TOP + count * THREAD_ROW + 24) };
}

/** The polyline through the markers in run order — the walked path. */
export function pathPoints(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Presentation leaves live in labyrinthFormat.ts; re-exported here.
export { formatDuration, formatClock, truncate, stepCaption, threadLabel } from './labyrinthFormat';
