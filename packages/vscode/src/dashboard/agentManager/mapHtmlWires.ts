// The static artifact's CONNECTORS: every edge as a bowed arrow with a label held
// in reserve, and every flow as a traced path with numbered steps. Split from
// mapHtmlSvg.ts (the solids) the same way isoWires.ts is split from isoLayout.ts.
//
// EVERYTHING IS RENDERED UP FRONT AND SHOWN BY CLASS. The flow traces and the
// edge labels are only visible when something is selected, and the obvious way to
// build them is at click time — which is exactly what the artifact must not do.
// Creating an SVG element at runtime needs createElementNS and its namespace URI,
// which would be the only `http://` string in a document whose whole contract is
// that it fetches nothing, and the guard test asserts that over the whole file.
// Rendering them hidden costs a few kilobytes and leaves the script with no DOM
// factory at all.

import type { IsoFlowPath, IsoLink } from './isoWires';
import type { Pt } from './isoProject';
import { polyPoints } from './isoProject';
import { FLOW_COLOR } from './mapPalette';

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A quadratic through one control point. The ONE place the curve is spelt as a
 *  path on this side of the seam; the numbers came from isoWires.ts. */
const quad = (a: Pt, c: Pt, b: Pt): string => `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;

/** A caption has no ellipsis in SVG, so an edge label is cut on the RAW string. */
const short = (s: string, max = 34): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Every edge: a curve, its arrowhead, and the label that lights up with it.
 *  `data-from`/`data-to` are what the script filters on, so it never needs to
 *  know the geometry it is highlighting. */
export function linkSvg(links: readonly IsoLink[]): string {
  return links.map((l, i) =>
    `<g class="lk" data-lk="${i}" data-from="${esc(l.from)}" data-to="${esc(l.to)}">`
    + `<path class="link" d="${quad(l.s, l.c, l.e)}" />`
    + `<polygon class="tip" points="${polyPoints(l.head)}" /></g>`
    + `<text class="elab" data-elab="${i}" x="${l.mid.x}" y="${l.mid.y - 4}">${esc(short(l.label))}</text>`).join('');
}

/** Every flow: its hops as bowed lines in the flow's colour, and one numbered
 *  badge per step. A revisited node keeps its FIRST number (isoWires.ts decides
 *  that; this file only draws what it is handed). */
export function traceSvg(flows: readonly IsoFlowPath[]): string {
  return flows.map((f) => {
    const colour = FLOW_COLOR[f.index % FLOW_COLOR.length];
    const lines = f.segs.map((s) => `<path class="flowline" d="${quad(s.a, s.c, s.b)}" stroke="${colour}" />`).join('');
    const marks = f.marks.map((m) =>
      `<g><circle cx="${m.at.x}" cy="${m.at.y}" r="9" fill="${colour}" stroke="#0b1220" stroke-width="1.5" />`
      + `<text class="stepn" x="${m.at.x}" y="${m.at.y + 1}">${m.n}</text></g>`).join('');
    return `<g class="trace" data-flow="${esc(f.id)}">${lines}${marks}</g>`;
  }).join('');
}
