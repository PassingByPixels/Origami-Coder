// The repo map's isometric FLOOR PLAN — the STREETS, and the assembly of the
// whole picture from the leaves around it. Pure: a RepoMap in, plain geometry
// out. No DOM, no markup, no colour.
//
// THE PLAN IS "FLOW SPINE" (Passing's pick, variant B of the cartographer
// mockups). Each flow becomes one STREET laid along the grid diagonal (+1,-1).
// That diagonal projects to a perfectly HORIZONTAL screen row — every box on one
// street shares x+y, so it shares its screen y — and consecutive streets are
// offset along (+1,+1), which is pure screen-DOWN. So a runtime path stops being
// a hunt across a diagonal band and becomes a line of text you read end to end.
//
// Two rules keep it honest:
//   1. FIRST STREET WINS. A component sits on the first flow that reaches it and
//      nowhere else, so nothing is drawn twice and "where does this live" has one
//      answer. Revisits inside a single flow are dropped the same way — three of
//      the four flows in the reference map re-enter the same node several times,
//      and the schema has no marker that separates a genuine second visit from a
//      duplicate (that idea is a wiki note, not code).
//   2. EVERYTHING ELSE DOCKS. Components no flow touches are packed into pillar
//      districts below the last street (isoDock.ts) instead of interrupting the
//      story.
//
// The cluster: isoProject.ts is the camera, isoBox.ts turns one node into a
// solid, isoPack.ts is the packing search, isoDock.ts places the leftovers, and
// isoWires.ts joins everything up.
//
// ONE COPY, ON THE HOST SIDE, ON PURPOSE. The webview cannot import a runtime
// value out of src/ (tsconfig.webview.json pins rootDir to `webview/`), and the
// house answer is normally to MIRROR the value with a drift guard. A mirror is
// the right trade for a constant table and the wrong one for a page of geometry,
// where the only guard you could write is a byte-compare. So the layout is
// computed once, here, and the RESULT is serialized: mapHtml.ts renders it into
// the static artifact, mapTab.ts puts it in the webview payload. Both consume
// numbers, and the screen imports only this file's TYPES — which the compiler
// checks, so the two pictures cannot drift at all.

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

/** A painted ground plate: one flow's street, or one pillar's district.
 *
 *  It carries the flow INDEX and the pillar NUMBER, never a name. Each renderer
 *  looks the pillar name up in its own PILLARS copy (which is what keeps the
 *  webview mirror load-bearing and its drift guard honest) and the flow name up
 *  in the map it was handed. */
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

  // Painter's order. An SVG has no depth buffer, so the ONLY thing that makes a
  // box in front cover the box behind it is being drawn later. Sorting here,
  // once, means neither renderer can get the occlusion wrong. `sort` is stable,
  // so boxes sharing a depth keep the order they were placed in.
  boxes.sort((a, b) => a.depth - b.depth);
  zones.sort((a, b) => a.depth - b.depth);

  const all: Pt[] = [];
  for (const z of zones) all.push(...z.poly);
  for (const b of boxes) for (const p of b.plates) all.push(...p.top, ...p.left, ...p.right);
  const wires = wireUp(map, boxes);
  return { boxes, zones, sectionLabels, ...wires, view: boundsOf(all, VIEW_PAD) };
}
