// CORRIDOR as a MINIMAP: the whole run on one screen, no scrolling.
//
// The old per-step corridor had no spare axis for branches (it already
// spends both axes on sequence), so it fell back to colour alone. The
// minimap trades step-by-step readability for showing the shape of a whole
// run — where failures are, where work was delegated — in one glance.
//
// Two consequences: the canvas is fixed (marker size and row pitch derive
// from the step count, never the other way round, so fit is arithmetic, not
// hope), and there are no per-step captions — density comes from dropping
// prose, with kind carried by the existing glyph tone plus, on the main
// thread only, the kind mark in labyrinthMarks.ts.
//
// A delegated stretch draws as an inset chamber: a nested block of small
// markers off the corridor line, so delegated work reads as a side-chamber.

import { isThreshold, normDepth, type LaneStep } from './labyrinthLanes';

/** The part of a step the minimap reads. `LayoutStep` extends this. */
export interface MinimapStep extends LaneStep {
  ordinal: number;
}

/**
 * The fixed canvas. Not a function of the step count — that is the point.
 * Height is the axis raised, since width is capped by the panel; a taller
 * box at the same step count means fewer, wider columns and more room for
 * kind marks.
 */
export const MINIMAP_WIDTH = 760;
export const MINIMAP_HEIGHT = 620;
const MARGIN = 22;
const CONTENT_W = MINIMAP_WIDTH - MARGIN * 2;
const CONTENT_H = MINIMAP_HEIGHT - MARGIN * 2;
/** Sub-agent steps packed per reserved cell — a 2-wide micro-grid per cell. */
const PER_CELL = 4;
const MICRO_COLS = 2;
/** Fractions of the cell pitch: marker radius, chamber inset, micro radius. */
const R_FRAC = 0.2;
const PAD_FRAC = 0.12;
const MICRO_R_FRAC = 0.28;
/** A failure is drawn bigger, not just a different colour — subtle at this density. */
const FAIL_SCALE = 1.45;

export interface MinimapPoint<S> {
  x: number;
  y: number;
  r: number;
  step: S;
  /** Index of the chamber this step is nested in, or -1 on the main corridor. */
  chamber: number;
}

export interface MinimapChamber {
  /** Index of the chamber's first step — unique, so it is also the render key. */
  key: number;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
}

export interface Minimap<S> {
  cols: number;
  rows: number;
  cellW: number;
  rowH: number;
  points: Array<MinimapPoint<S>>;
  chambers: MinimapChamber[];
  /** Main-thread cell centres in run order — the corridor actually walked. */
  trail: Array<{ x: number; y: number }>;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Maximal runs of delegated steps, each attributed to the spawn before it. */
function groupsOf(steps: readonly MinimapStep[]): Array<{ delegated: boolean; idx: number[] }> {
  const out: Array<{ delegated: boolean; idx: number[] }> = [];
  steps.forEach((step, i) => {
    const delegated = normDepth(step) > 0;
    const tail = out[out.length - 1];
    if (delegated && tail?.delegated) tail.idx.push(i);
    else out.push({ delegated, idx: [i] });
  });
  return out;
}

const cellsFor = (n: number): number => Math.max(1, Math.ceil(n / PER_CELL));

/**
 * The whole run placed inside the fixed canvas. Column count tiles the
 * content box at its own aspect; row pitch is capped by both cell width and
 * available height, so the fit is a guarantee, not a tuning exercise. A
 * chamber never straddles a row end — it is pushed to the next row instead.
 */
export function minimapLayout<S extends MinimapStep>(steps: readonly S[]): Minimap<S> {
  const groups = groupsOf(steps);
  const est = groups.reduce((n, g) => n + (g.delegated ? cellsFor(g.idx.length) : 1), 0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, est) * (CONTENT_W / CONTENT_H))));

  // Reserve cells first, so `rows` counts the pushes as well as the steps.
  let cell = 0;
  const placed = groups.map((g) => {
    const m = g.delegated ? Math.min(cellsFor(g.idx.length), cols) : 1;
    if (m > 1 && (cell % cols) + m > cols) cell = (Math.floor(cell / cols) + 1) * cols;
    const c0 = cell;
    cell += m;
    return { g, c0, m };
  });

  const rows = Math.max(1, Math.ceil(Math.max(1, cell) / cols));
  const cellW = CONTENT_W / cols;
  const rowH = Math.min(cellW, CONTENT_H / rows);
  const pitch = Math.min(cellW, rowH);
  const base = clamp(pitch * R_FRAC, 2, 7);
  const pad = pitch * PAD_FRAC;
  const rad = (step: MinimapStep, r: number): number => (isThreshold(step) ? r * FAIL_SCALE : r);
  // Odd rows are walked backwards — corridor's identity, kept.
  const centre = (c: number) => {
    const row = Math.floor(c / cols);
    const within = c % cols;
    const col = row % 2 === 0 ? within : cols - 1 - within;
    return { x: MARGIN + (col + 0.5) * cellW, y: MARGIN + (row + 0.5) * rowH, row };
  };

  const points = new Array<MinimapPoint<S>>(steps.length);
  const chambers: MinimapChamber[] = [];
  const trail: Array<{ x: number; y: number }> = [];

  for (const { g, c0, m } of placed) {
    if (!g.delegated) {
      const at = centre(c0);
      const i = g.idx[0]!;
      points[i] = { x: at.x, y: at.y, r: rad(steps[i]!, base), step: steps[i]!, chamber: -1 };
      trail.push({ x: at.x, y: at.y });
      continue;
    }
    const a = centre(c0);
    const b = centre(c0 + m - 1);
    const box = {
      key: g.idx[0]!,
      x: Math.min(a.x, b.x) - cellW / 2 + pad,
      y: a.y - rowH / 2 + pad,
      w: Math.abs(b.x - a.x) + cellW - 2 * pad,
      h: rowH - 2 * pad,
      count: g.idx.length,
    };
    const mc = m * MICRO_COLS;
    const mw = box.w / mc;
    const mh = box.h / Math.max(1, Math.ceil(g.idx.length / mc));
    const mr = clamp(Math.min(mw, mh) * MICRO_R_FRAC, 1, base * 0.6);
    g.idx.forEach((i, j) => {
      const within = j % mc;
      const col = a.row % 2 === 0 ? within : mc - 1 - within;
      points[i] = {
        x: box.x + (col + 0.5) * mw,
        y: box.y + (Math.floor(j / mc) + 0.5) * mh,
        r: rad(steps[i]!, mr),
        step: steps[i]!,
        chamber: box.key,
      };
    });
    chambers.push(box);
  }

  return { cols, rows, cellW, rowH, points, chambers, trail };
}
