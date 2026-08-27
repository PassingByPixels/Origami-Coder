// The corridor minimap's per-marker KIND MARK — one character that says what a
// main-thread step actually was, so the shape of a run is readable without
// clicking every dot in it.
//
// Why a CHARACTER and not the LabyrinthGlyph the other two modes draw: at the
// minimap's derived pitch a cell is ~34 user units at 336 steps, which leaves
// roughly 11 units for a mark. LabyrinthGlyph's figures are 24x24 multi-stroke
// paths (the tool mark alone is three strokes plus a filled dot) — scaled to 11
// they are a smudge, and the smudges for `tool` and `subagent` are the same
// smudge. A capital in the SVG's own monospace family keeps its stroke weight
// at that size, and it is one <text> per marker rather than a nested <svg> at
// up to 500 markers.
//
// This is NOT a second symbol language. The mark is keyed on the step's RAW
// kind exactly as LabyrinthGlyph's shape is, and its colour comes from the
// unchanged `tone-{stepGlyph(step)}` class on the marker's own group — so a
// failed tool still shows the tool mark and only its tone changes, which is the
// rule labyrinthLanes.ts already states.

import type { LaneStep } from './labyrinthLanes';

/**
 * One character per kind. Letters where a letter is unambiguous, punctuation
 * where it would not be: `tool` and `thinking` both want T, so thinking takes
 * `?` (deliberating) and error takes `!` — two shapes no letter can be mistaken
 * for at 9 units. An UNKNOWN kind gets no mark at all rather than a wrong one.
 */
const MARKS: Record<string, string> = {
  prompt: 'P', reply: 'R', tool: 'T', thinking: '?', subagent: 'S', error: '!',
};

export function kindMark(kind: LaneStep['kind'] | string): string {
  return MARKS[kind] ?? '';
}

/** Below this the character is a smear; a dropped mark is better than one. */
const MARK_MIN = 7;
/** Above this it stops being a mark and starts competing with the marker. */
const MARK_MAX = 11;
const MARK_FRAC = 0.32;
/** Over-estimated monospace advance, as a fraction of the font size. */
export const MARK_CHAR_W = 0.65;
/** Gap between the marker's own edge and the mark's left side. */
const MARK_GAP = 2;

/**
 * Mark size for a cell pitch, or 0 when there is no legible size to draw at.
 *
 * The FIT is arithmetic, not tuning: the mark starts at the marker's radius
 * (at most 0.29 * pitch, radius clamp times FAIL_SCALE) and runs
 * MARK_CHAR_W * size (at most 0.21 * pitch) further, so a mark on the outermost
 * column ends at most 0.5 * cellW + 2 past that column's centre — which is the
 * half-cell the cell grid already reserves, before the canvas margin.
 */
export function markSize(pitch: number): number {
  const size = Math.min(MARK_MAX, pitch * MARK_FRAC);
  return size >= MARK_MIN ? size : 0;
}

/** Just clear of the marker's own edge, on the side the label column is on. */
export function markX(x: number, r: number): number {
  return x + r + MARK_GAP;
}

/** Baseline placed so the character's body sits centred on the marker's row. */
export function markY(y: number, size: number): number {
  return y + size * 0.36;
}
