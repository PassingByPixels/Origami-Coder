// What JOINS the boxes: the bowed connector an edge is drawn as, and the traced
// path a flow lights up. Pure screen-space geometry — points in, points out.
//
// Split from isoLayout.ts because it answers a different question. The floor plan
// decides where a component STANDS (and changes whenever the grouping rules do);
// this decides what a line between two standing points LOOKS like (and changes
// when the drawing language does). Keeping them apart also lets the curve be
// asserted on hand-computed numbers, which is the only way the arrowhead's sign
// gets caught — a head pointing at the wrong end still draws a plausible arrow.
//
// NO PATH STRINGS ARE BUILT HERE. Each renderer formats `M s Q c e` itself, the
// same way polyPoints() is the one formatter for a polygon. A `d=` attribute
// built in this module would be markup in a geometry file, and the webview would
// have to trust a string instead of numbers the compiler can check.

import type { Pt } from './isoProject';
import type { RepoMap } from './mapSchema';
import type { IsoBox } from './isoLayout';

/** Gap left between a box centre and the end of its connector, so the line does
 *  not disappear under the solid it points at. */
const END_PAD = 9;
/** Arrowhead length and half-width, in screen px. */
const HEAD_LEN = 8;
const HEAD_HALF = 4;

export interface IsoLink {
  from: string;
  to: string;
  label: string;
  /** Start, quadratic control point, end. */
  s: Pt;
  c: Pt;
  e: Pt;
  /** The three corners of the arrowhead at `e`. */
  head: Pt[];
  /** Point on the curve where its label sits. */
  mid: Pt;
}

/** One hop of a traced flow: a quadratic from `a` to `b` bowed through `c`. */
export interface IsoFlowSeg {
  a: Pt;
  c: Pt;
  b: Pt;
}

/** The numbered badge over a step. A revisited node keeps its FIRST number. */
export interface IsoFlowMark {
  n: number;
  at: Pt;
}

export interface IsoFlowPath {
  id: string;
  /** Index into map.flows — the street it owns and the colour it is drawn in. */
  index: number;
  segs: IsoFlowSeg[];
  marks: IsoFlowMark[];
}

/** Unit vector a->b, or null when the two points are effectively the same — the
 *  case every divisor below would otherwise turn into NaN. */
function unit(a: Pt, b: Pt): { ux: number; uy: number; len: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len > 0.5 ? { ux: dx / len, uy: dy / len, len } : null;
}

/** The control point that bows the straight line a->b sideways.
 *  Perpendicular is (uy, -ux), so the bow always goes to the SAME side and the
 *  two directions of a mutual dependency draw as two distinct curves. */
function bowed(a: Pt, b: Pt, max: number, share: number): Pt | null {
  const u = unit(a, b);
  if (!u) return null;
  const bow = Math.min(max, u.len * share);
  return { x: (a.x + b.x) / 2 + u.uy * bow, y: (a.y + b.y) / 2 - u.ux * bow };
}

/** One edge as a curve with an arrowhead, or null when the two boxes sit on top
 *  of each other (a self-edge, or two nodes the packer put in one cell) — a
 *  zero-length curve has no direction, so an arrowhead built from it is NaN. */
export function arcOf(a: Pt, b: Pt): Omit<IsoLink, 'from' | 'to' | 'label'> | null {
  const line = unit(a, b);
  if (!line) return null;
  const s = { x: a.x + line.ux * END_PAD, y: a.y + line.uy * END_PAD };
  const e = { x: b.x - line.ux * END_PAD, y: b.y - line.uy * END_PAD };
  const c = bowed(s, e, 34, 0.16);
  if (!c) return null;
  // Tangent at the END of a quadratic is 2 * (e - c) — the direction the head
  // must point. Taken from the curve, not from a->b, or the head sits skew to
  // the line it terminates.
  const tx = 2 * (e.x - c.x);
  const ty = 2 * (e.y - c.y);
  const tl = Math.sqrt(tx * tx + ty * ty);
  if (!(tl > 0.001)) return null;
  const tux = tx / tl;
  const tuy = ty / tl;
  const bx = e.x - tux * HEAD_LEN;
  const by = e.y - tuy * HEAD_LEN;
  return {
    s, c, e,
    head: [e, { x: bx - tuy * HEAD_HALF, y: by + tux * HEAD_HALF }, { x: bx + tuy * HEAD_HALF, y: by - tux * HEAD_HALF }],
    mid: { x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y },
  };
}

/** Every edge as a connector, and every flow as a traced path with numbered
 *  steps. Edges naming a node the layout dropped are skipped rather than drawn
 *  to the origin. */
export function wireUp(map: RepoMap, boxes: readonly IsoBox[]): { links: IsoLink[]; flowPaths: IsoFlowPath[] } {
  const centre = new Map(boxes.map((b) => [b.id, b.centre]));
  const links: IsoLink[] = [];
  for (const edge of map.edges) {
    const a = centre.get(edge.from);
    const b = centre.get(edge.to);
    if (!a || !b) continue;
    const geo = arcOf(a, b);
    if (geo) links.push({ from: edge.from, to: edge.to, label: edge.label, ...geo });
  }
  const flowPaths = map.flows.map((f, index) => {
    const seq = f.steps.map((step) => ({ id: step.node, p: centre.get(step.node) })).filter((x): x is { id: string; p: Pt } => !!x.p);
    const segs: IsoFlowSeg[] = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const c = bowed(seq[i].p, seq[i + 1].p, 58, 0.22);
      if (c) segs.push({ a: seq[i].p, c, b: seq[i + 1].p });
    }
    const seen = new Set<string>();
    const marks: IsoFlowMark[] = [];
    seq.forEach((step, i) => {
      if (seen.has(step.id)) return;
      seen.add(step.id);
      marks.push({ n: i + 1, at: { x: step.p.x, y: step.p.y - 20 } });
    });
    return { id: f.id, index, segs, marks };
  });
  return { links, flowPaths };
}
