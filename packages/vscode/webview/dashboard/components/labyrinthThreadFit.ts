// How much furniture one thread marker may print before it hits the
// column beside it. Everything LabyrinthNode.svelte draws was sized for
// the spine (a LANE_GAP away); branch columns sit much closer
// (BRANCH_COL_GAP), so the budget must come from the pitch at the
// point, never the spine's.
//
// Where a strip is too dense to print a label legibly, drop it — never
// overlap or clip. Pure and DOM-free: jsdom has no layout engine, so an
// overlap can only be caught as arithmetic.

import { LANE_GAP } from './labyrinthLanes';
import { BRANCH_COL_GAP } from './labyrinthRails';
import { branchModel, type BranchStep } from './labyrinthBranches';
import { THREAD_META_DX } from './labyrinthLayout';

/** Widest the meta text gets — "1234 · 12m 30s" at 11px tabular figures. */
const META_W = 71;
/** LabyrinthGlyph.svelte's box, and where the node offsets it. */
const GLYPH_DX = 12;
const GLYPH_W = 18;
/** Smallest a glyph may be squeezed to and still read as its own shape. */
const GLYPH_MIN = 6;
/** The threshold bar's half-width on the spine, and the gap it keeps. */
const THRESH_HALF = 26;
const THRESH_CLEAR = 2;

/** How many branch columns a run occupies. A lone sub-agent's column
 *  neighbours only the spine (a full LANE_GAP away) and keeps every
 *  label; a second concurrent one starts crowding. */
export function branchColumns(steps: readonly BranchStep[]): number {
  return branchModel(steps).column.reduce((n, c) => Math.max(n, c + 1), 0);
}

/** Distance to the nearest occupied column at `pointX`. A branch column
 *  starts one LANE_GAP left of the spine; a second column packs the
 *  grid to BRANCH_COL_GAP, otherwise it's a lane, a full LANE_GAP away. */
export function columnPitch(pointX: number, spineX: number, columns: number): number {
  return pointX <= spineX - LANE_GAP && columns > 1 ? BRANCH_COL_GAP : LANE_GAP;
}

/** Whether the ordinal/duration text can be printed BESIDE the marker at all. */
export function metaFits(pitch: number): boolean {
  return THREAD_META_DX + META_W <= pitch;
}

/** Half-width of the threshold bar: never wider than the pitch it sits in. */
export function threshHalf(pitch: number): number {
  return Math.min(THRESH_HALF, pitch / 2 - THRESH_CLEAR);
}

/**
 * The kind glyph, clamped rather than dropped: its shape is the only
 * place a marker says what kind of step it is. It clears the
 * neighbour's threshold bar (drawn even with the filter off), not its marker.
 */
export function glyphSize(pitch: number): number {
  return Math.max(GLYPH_MIN, Math.min(GLYPH_W, pitch - threshHalf(pitch) - GLYPH_DX));
}

/**
 * Label budget once the meta has moved into the caption. The prefix and
 * its separator share the budget, so a prefixed row stays inside the
 * viewBox — it clips silently, so landing short is the safe direction.
 */
export function captionChars(max: number, prefix: string): number {
  return Math.max(8, max - prefix.length - 3); // 3 = the " · " that joins them
}
