// The static artifact's connectors: bowed edge arrows and traced flow paths, rendered up
// front and shown by class rather than built at click time, since building at runtime would
// need createElementNS and its namespace URI — the document's only http:// string, which the
// guard test forbids.

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

/** Every edge as a curve+arrowhead+label; `data-from`/`data-to` are what the script filters
 *  on so it never needs the highlighted geometry itself. */
export function linkSvg(links: readonly IsoLink[]): string {
  return links.map((l, i) =>
    `<g class="lk" data-lk="${i}" data-from="${esc(l.from)}" data-to="${esc(l.to)}">`
    + `<path class="link" d="${quad(l.s, l.c, l.e)}" />`
    + `<polygon class="tip" points="${polyPoints(l.head)}" /></g>`
    + `<text class="elab" data-elab="${i}" x="${l.mid.x}" y="${l.mid.y - 4}">${esc(short(l.label))}</text>`).join('');
}

/** Every flow as bowed hops in its colour plus numbered badges; a revisited node keeps its
 *  first number (decided in isoWires.ts). */
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
