// The static artifact's PICTURE: the ground plates, the solids and their labels,
// assembled from the geometry isoLayout.ts already computed. The connectors are
// mapHtmlWires.ts's, split off for the same reason isoWires.ts is split from
// isoLayout.ts — a box and a line between two boxes change for different causes.
//
// NO GEOMETRY IS INVENTED HERE. Every coordinate arrives from layoutMap(), so the
// in-editor screen and this file draw the same picture by construction rather
// than by two people keeping two sets of maths in step.
//
// Boxes are emitted in the order layoutMap() sorted them (back to front). SVG has
// no depth buffer, so that order IS the occlusion — re-sorting here would silently
// put the far boxes on top.
//
// Colour is written INLINE, per node, rather than through a CSS class per kind:
// the three faces of one solid are three shades of one hue, and shade() is a
// single expression on the host. A class-per-kind sheet would be 8 kinds x 3
// faces of near-duplicate rules that a new `kind` in a map would fall out of.

import type { IsoBox, IsoLayout, IsoZone } from './isoLayout';
import { polyPoints } from './isoProject';
import { colourOf, FLOW_COLOR, PILLAR_COLOR, shade } from './mapPalette';
import { linkSvg, traceSvg } from './mapHtmlWires';
import { PILLARS, type RepoMap } from './mapSchema';

/** Escape a map string for HTML/SVG text and attribute positions. Every value in
 *  the artifact that came from the cartographer goes through this. */
export const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pillar name by number, from the schema's own table — this file keeps no copy
 *  of the five pillars (it used to, unguarded by the mirror's drift test). */
export const pillarName = (n: number): string => PILLARS.find((p) => p.number === n)?.name ?? `Pillar ${n}`;

/** A caption has no ellipsis in SVG, so a long name is cut here and the full one
 *  lives in the <title> the browser shows on hover. Cut on the RAW name: escaping
 *  first would slice `&amp;` into `&a`, which renders as literal text. */
const short = (s: string, max = 22): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One solid: the two side faces darkened from the kind's hue, the top face in
 *  the hue itself, outlined a shade lighter so it reads against its own sides. */
function solid(faces: { top: readonly { x: number; y: number }[]; left: readonly { x: number; y: number }[]; right: readonly { x: number; y: number }[] }, base: string): string {
  return `<polygon class="left" points="${polyPoints(faces.left)}" fill="${shade(base, 0.5)}" stroke="${shade(base, 0.32)}" stroke-width="0.7" />`
    + `<polygon class="right" points="${polyPoints(faces.right)}" fill="${shade(base, 0.74)}" stroke="${shade(base, 0.42)}" stroke-width="0.7" />`
    + `<polygon class="top" points="${polyPoints(faces.top)}" fill="${base}" stroke="${shade(base, 1.35)}" stroke-width="0.8" />`;
}

function nodeSvg(b: IsoBox): string {
  const base = colourOf(b.kind);
  const title = b.path ? `${b.name} — ${b.path}` : b.name;
  return `<g class="node" data-node="${esc(b.id)}" data-kind="${esc(b.kind)}" data-pillar="${b.pillar}"`
    + ` tabindex="0" role="button" aria-label="${esc(b.name)}">`
    + b.plates.map((f) => solid(f, base)).join('')
    + `<text class="badge" x="${b.centre.x}" y="${b.centre.y + 1}">${esc(b.code)}</text>`
    + `<title>${esc(title)}</title></g>`;
}

/** A street's tint is its flow's colour; a district's is its pillar's. The LABEL
 *  is composed here from the map and the schema's pillar table — the geometry
 *  carries only the flow index and the pillar number. */
function zoneSvg(z: IsoZone, map: RepoMap): { plate: string; label: string } {
  const street = z.kind === 'street';
  const flow = street ? map.flows[z.flow] : undefined;
  const colour = street ? FLOW_COLOR[z.flow % FLOW_COLOR.length] : PILLAR_COLOR[z.pillar] ?? '#64748b';
  const head = street
    ? `FLOW ${z.flow + 1} · ${flow ? flow.name : ''}`
    : `${z.pillar} · ${pillarName(z.pillar)}`;
  const sub = street
    ? `${flow ? flow.steps.length : 0} steps · ${z.count} components live here`
    : `${z.count} off-flow components`;
  const plate = `<polygon class="zone" points="${polyPoints(z.poly)}" fill="${shade(colour, 0.2)}"`
    + ` stroke="${shade(colour, 0.8)}" stroke-width="1.2"${street ? '' : ' stroke-dasharray="6 5"'} />`;
  const label = `<text class="zlab" x="${z.label.x}" y="${z.label.y}" fill="${shade(colour, 1.4)}" text-anchor="${z.anchor}">${esc(head)}</text>`
    + `<text class="zsub" x="${z.label.x}" y="${z.label.y + 12}" text-anchor="${z.anchor}">${esc(sub)}</text>`;
  return { plate, label };
}

/** The whole picture. `#cam` is the one element the pan/zoom script transforms. */
export function isoSvg(layout: IsoLayout, map: RepoMap): string {
  const v = layout.view;
  const zones = layout.zones.map((z) => zoneSvg(z, map));
  const sections = layout.sectionLabels.map((s) =>
    `<text class="slab" x="${s.at.x}" y="${s.at.y}">${esc(`${s.section} (${s.count})`)}</text>`).join('');
  const captions = layout.boxes.map((b) =>
    `<text class="caption" data-name="${esc(b.id)}" data-deg="${b.degree + b.flows}" x="${b.foot.x}" y="${b.foot.y}">${esc(short(b.name))}</text>`).join('');
  // No xmlns: the <svg> is INLINE in HTML, where the parser assigns the SVG
  // namespace itself. Emitting the namespace URI would put the only `http://`
  // string in the whole artifact into a file whose contract is that it fetches
  // nothing — and the guard test asserts that literally, on the whole document.
  return `<svg id="stage" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" preserveAspectRatio="xMidYMid meet">`
    + `<g id="cam"><g id="zones">${zones.map((z) => z.plate).join('')}</g>`
    + `<g id="boxes">${layout.boxes.map(nodeSvg).join('')}</g>`
    + `<g id="links">${linkSvg(layout.links)}</g>`
    + `<g id="flows">${traceSvg(layout.flowPaths)}</g>`
    + `<g id="zlab">${zones.map((z) => z.label).join('')}${sections}</g>`
    + `<g id="names">${captions}</g></g></svg>`;
}
