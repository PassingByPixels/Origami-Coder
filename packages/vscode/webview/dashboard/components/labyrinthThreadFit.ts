// How much furniture ONE thread marker may print before it runs into the
// column beside it.
//
// Everything LabyrinthNode.svelte draws around a marker was sized for the
// SPINE, whose nearest neighbour is a LANE_GAP (110 units) away. Branch
// columns are only BRANCH_COL_GAP (40) apart, and nothing clamped any of it to
// that pitch, so from two concurrent sub-agents onward a node's ordinal /
// duration text ran from x+34 to about x+105 — straight across the neighbour
// at x+40 and often the one at x+80. The budget therefore has to come from the
// pitch AT THE POINT, never from the spine's.
//
// The file's own rule is LabyrinthNode.svelte's: where the strip is too dense
// to print a label legibly it is DROPPED, never overlapped — and never clipped
// either, which would hide the overrun instead of resolving it.
//
// Pure and DOM-free, like labyrinthCollide.ts beside it: jsdom has no layout
// engine, so an overlap can only be caught as arithmetic.

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

/**
 * How many branch columns a run actually occupies. This is the whole reason
 * the defect "shows up from two concurrent sub-agents onward": ONE column's
 * nearest neighbour is the spine, a full LANE_GAP away, so a lone sub-agent
 * crowds nothing and must keep every label it has.
 */
export function branchColumns(steps: readonly BranchStep[]): number {
  return branchModel(steps).column.reduce((n, c) => Math.max(n, c + 1), 0);
}

/**
 * Distance to the nearest OCCUPIED column at `pointX`. A branch column starts
 * exactly one LANE_GAP left of the spine (branchX), so anything at or left of
 * that is on the branch grid — and only once a SECOND column is in use is that
 * grid packed BRANCH_COL_GAP apart. Everything else is a lane, a whole
 * LANE_GAP from the trunk.
 */
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
 * The kind glyph, CLAMPED rather than dropped — its shape is the only place a
 * marker says what kind of step it is, so shrinking it loses nothing while
 * dropping it would. What it has to clear is the neighbour's THRESHOLD BAR,
 * not its marker: the bar reaches threshHalf back towards us and is drawn even
 * with the filter off, so it is the nearer edge of the two.
 */
export function glyphSize(pitch: number): number {
  return Math.max(GLYPH_MIN, Math.min(GLYPH_W, pitch - threshHalf(pitch) - GLYPH_DX));
}

/**
 * Label budget once the meta has moved INTO the caption. The prefix and its
 * separator come out of the same budget, so a prefixed row still ends inside
 * the viewBox — the SVG viewport clips silently, so landing short is the only
 * safe direction to be wrong in (labyrinthLayout.ts's THREAD_LABEL_CHARS).
 */
export function captionChars(max: number, prefix: string): number {
  return Math.max(8, max - prefix.length - 3); // 3 = the " · " that joins them
}
