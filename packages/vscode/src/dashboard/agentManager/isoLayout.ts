// The repo map's isometric floor plan: the streets, and assembly of the whole picture. Pure
// — a RepoMap in, geometry out.
// Plan is "flow spine": each flow becomes one street laid on the grid diagonal (+1,-1), which
// projects to a perfectly horizontal screen row, so a runtime path reads as a line of text
// end to end. Two rules: (1) first street wins — a component sits on the first flow that
// reaches it, so nothing draws twice; (2) everything else docks into pillar districts below
// the last street (isoDock.ts) instead of interrupting the story.
// The layout is computed once, host-side, and the RESULT serialized to both the static
// map.html and the webview payload — the webview can't import a runtime value from src/, and
// mirroring ~180 lines of geometry with only a byte-compare guard is the wrong trade, so both
// renderers consume numbers instead.

import { boundsOf, project, type Pt } from './isoProject';
import { emit, sizesOf, type IsoBox, type Sizes } from './isoBox';
import { dockDistricts } from './isoDock';
import { wireUp, type IsoFlowPath, type IsoLink } from './isoWires';
import type { MapNode, RepoMap } from './mapSchema';

/** Clearance between neighbours ON a street, and around the road plate. */
const STREET_STEP = 0.7;
const ROAD_PAD = 0.9;
/** Grid steps between one street and the next. 2 * PITCH * HY px apart. */
const STREET_PITCH = 8.5;
/** Slack around the whole picture, in screen px. */
const VIEW_PAD = 64;

/** A painted ground plate: one flow's street or one pillar's district, carrying the flow
 *  index/pillar number (never a name) — each renderer looks the name up itself. */
export interface IsoZone {
  kind: 'street' | 'district';
  /** Index into map.flows for a street; -1 for a district. */
  flow: number;
  /** Pillar number for a district; -1 for a street. */
  pillar: number;
  poly: Pt[];
  label: Pt;
  anchor: 'start' | 'middle';
  /** Components standing on this plate. */
  count: number;
  depth: number;
}

/** The caption over one section block inside a district. */
export interface IsoSectionLabel {
  section: string;
  count: number;
  at: Pt;
}

export interface IsoLayout {
  boxes: IsoBox[];
  zones: IsoZone[];
  sectionLabels: IsoSectionLabel[];
  links: IsoLink[];
  flowPaths: IsoFlowPath[];
  /** Screen-space viewBox covering the whole picture, already padded. */
  view: { x: number; y: number; w: number; h: number };
}

// Re-exported so both renderers have ONE import for the shape of the payload
// they were handed, rather than having to know which leaf declared which half.
export type { IsoBox } from './isoBox';
export { codeOf } from './isoBox';
export { groupNodes } from './isoDock';

/** One street per flow, in flow order. Returns the screen-x span of the roads so
 *  the district slab below can be centred on them. */
function streets(map: RepoMap, s: Sizes, placed: Set<string>, boxes: IsoBox[], zones: IsoZone[]): number[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const spanX: number[] = [];
  map.flows.forEach((f, si) => {
    const own: MapNode[] = [];
    for (const step of f.steps) {
      const n = byId.get(step.node);
      if (!n || placed.has(n.id)) continue;
      placed.add(n.id);
      own.push(n);
    }
    const base = si * STREET_PITCH;
    let off = 0;
    let prevFp = 0;
    let maxFp = 0;
    for (const n of own) {
      const fp = s.fp(n);
      if (prevFp > 0) off += Math.max(prevFp, fp) + STREET_STEP;
      emit(n, base + off, base - off, s, boxes);
      prevFp = fp;
      maxFp = Math.max(maxFp, fp);
    }
    // The road plate is an axis-aligned SCREEN rectangle, built in the (u, v)
    // frame where u runs ALONG the street and v runs across it.
    const uv = (u: number, v: number): Pt => project(base + u + v, base - u + v);
    const poly = [
      uv(-maxFp / 2 - ROAD_PAD, -ROAD_PAD), uv(off + maxFp / 2 + ROAD_PAD, -ROAD_PAD),
      uv(off + maxFp / 2 + ROAD_PAD, maxFp + ROAD_PAD), uv(-maxFp / 2 - ROAD_PAD, maxFp + ROAD_PAD),
    ];
    spanX.push(poly[0].x, poly[1].x);
    zones.push({
      kind: 'street', flow: si, pillar: -1, poly, count: own.length,
      label: { x: poly[0].x + 4, y: poly[0].y - 20 }, anchor: 'start', depth: 2 * base - 0.5,
    });
  });
  return spanX;
}

/** Place every node, plate the streets and districts, and join it all up.
 *  Deterministic: same map in, same numbers out. */
export function layoutMap(map: RepoMap): IsoLayout {
  const s = sizesOf(map);
  const boxes: IsoBox[] = [];
  const zones: IsoZone[] = [];
  const sectionLabels: IsoSectionLabel[] = [];
  const placed = new Set<string>();

  const spanX = streets(map, s, placed, boxes, zones);
  dockDistricts(map, s, placed, spanX, boxes, zones, sectionLabels);

  // Painter's order: an SVG has no depth buffer, so drawing later is the only thing that makes
  // a box in front cover one behind. Sort is stable, so same-depth boxes keep placement order.
  boxes.sort((a, b) => a.depth - b.depth);
  zones.sort((a, b) => a.depth - b.depth);

  const all: Pt[] = [];
  for (const z of zones) all.push(...z.poly);
  for (const b of boxes) for (const p of b.plates) all.push(...p.top, ...p.left, ...p.right);
  const wires = wireUp(map, boxes);
  return { boxes, zones, sectionLabels, ...wires, view: boundsOf(all, VIEW_PAD) };
}
