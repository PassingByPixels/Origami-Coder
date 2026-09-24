// The connectors: bowed edges and traced flow paths, in pure screen-space geometry. Split
// from isoLayout.ts because it answers "what does a line between two points look like"
// rather than "where does a component stand". No path strings are built here — each renderer
// formats its own `d=` attribute from the numbers, keeping markup out of the geometry file.

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

/** The control point that bows a straight line sideways; perpendicular is (uy,-ux) so the
 *  bow always goes the same side, and a mutual dependency's two edges draw as distinct curves. */
function bowed(a: Pt, b: Pt, max: number, share: number): Pt | null {
  const u = unit(a, b);
  if (!u) return null;
  const bow = Math.min(max, u.len * share);
  return { x: (a.x + b.x) / 2 + u.uy * bow, y: (a.y + b.y) / 2 - u.ux * bow };
}

/** One edge as a curve+arrowhead, or null when the two boxes coincide (a self-edge, or two
 *  nodes the packer placed in one cell) — a zero-length curve has no direction. */
export function arcOf(a: Pt, b: Pt): Omit<IsoLink, 'from' | 'to' | 'label'> | null {
  const line = unit(a, b);
  if (!line) return null;
  const s = { x: a.x + line.ux * END_PAD, y: a.y + line.uy * END_PAD };
  const e = { x: b.x - line.ux * END_PAD, y: b.y - line.uy * END_PAD };
  const c = bowed(s, e, 34, 0.16);
  if (!c) return null;
  // Tangent at the curve's end is 2*(e-c) — taken from the curve itself, not from a->b, or
  // the arrowhead sits skew to the line.
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

/** Every edge as a connector and every flow as a traced path with numbered steps; edges
 *  naming a dropped node are skipped rather than drawn to the origin. */
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
