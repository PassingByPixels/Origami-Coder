// ONE COMPONENT AS A SOLID: how big it is, how tall it stands, what its badge
// says, and the faces that get drawn for it. Pure — a node and a grid cell in,
// geometry out.
//
// Split from isoLayout.ts, which decides WHERE things stand. This is the part
// both placements share: a box on a flow street and a box docked in a district
// are sized by exactly the same rules, and having one `emit` is what guarantees
// that. It is also the only file that knows pillar 5 is drawn as a stack.

import { boxFaces, project, type IsoFaces, type Pt } from './isoProject';
import type { MapNode, RepoMap } from './mapSchema';

/** An artifact stack: plate thickness and the pitch between plates. */
const PLATE_H = 0.55;
const PLATE_PITCH = 1.1;

export interface IsoBox {
  id: string;
  name: string;
  /** One- or two-character badge drawn on the top face. */
  code: string;
  kind: string;
  path?: string;
  summary: string;
  status?: string;
  section?: string;
  pillar: number;
  /** Edges touching this node. It sizes the footprint and shows in the panel. */
  degree: number;
  /** Flows visiting this node. It sets the box height and the auto-label rule. */
  flows: number;
  /** One entry per drawn solid: a plain box has one, an artifact stack several. */
  plates: IsoFaces[];
  /** Top-face centre of the TOPMOST plate — badge anchor and line endpoint. */
  centre: Pt;
  /** Where the caption sits, already offset clear of the solid. */
  foot: Pt;
  /** gx + gy — the painter's-order key. `boxes` arrives ALREADY sorted by it, so
   *  a renderer that iterates in order gets correct occlusion; one that re-sorted
   *  by screen y would put tall boxes in front of the short ones standing before
   *  them, which is the classic iso mistake. */
  depth: number;
}

/** The map's own numbers, resolved once: how connected each node is, how many
 *  flows touch it, how big that makes it. */
export interface Sizes {
  fp: (n: MapNode) => number;
  height: (n: MapNode) => number;
  degree: (id: string) => number;
  flows: (id: string) => number;
}

/**
 * Footprint from connectivity, height from flow participation — so a hub looks
 * like a hub with nobody hand-placing it.
 *
 * Key files get a FLOOR of 3 cells, and that is not decoration: half the nodes in
 * a real map have degree 0, so degree alone is a flat signal and the handful of
 * files the map itself calls important would come out the same size as a leaf.
 */
export function sizesOf(map: RepoMap): Sizes {
  const degree = new Map<string, number>();
  for (const e of map.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const flowCount = new Map<string, number>();
  for (const f of map.flows) {
    for (const id of new Set(f.steps.map((s) => s.node))) flowCount.set(id, (flowCount.get(id) ?? 0) + 1);
  }
  const keyPaths = new Set((map.keyFiles ?? []).map((k) => k.path));
  const deg = (id: string): number => degree.get(id) ?? 0;
  const flw = (id: string): number => flowCount.get(id) ?? 0;
  return {
    degree: deg,
    flows: flw,
    fp: (n) => Math.max(2 + Math.min(2, Math.floor(deg(n.id) / 2)), n.path && keyPaths.has(n.path) ? 3 : 0),
    height: (n) => 2 + Math.min(4, flw(n.id)),
  };
}

/** The badge. Initials of the first two words, else the first two characters —
 *  iterated by CODE POINT so a name starting with an astral character is not cut
 *  in half into two broken surrogates. */
export function codeOf(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return [...name.trim()].slice(0, 2).join('') || '?';
}

/** Stand one node on the grid at (gx, gy) and append its solid.
 *
 *  Pillar 5 is Artifacts & Outputs, so its nodes are drawn as a STACK of thin
 *  plates rather than one block — a pile of generated files, readable as such
 *  from across the diagram. */
export function emit(n: MapNode, gx: number, gy: number, s: Sizes, out: IsoBox[]): void {
  const fp = s.fp(n);
  const flows = s.flows(n.id);
  const plates: IsoFaces[] = [];
  if (n.pillar === 5) {
    const count = Math.min(4, 2 + flows);
    for (let i = 0; i < count; i++) plates.push(boxFaces(gx, gy, fp, fp, PLATE_H, i * PLATE_PITCH));
  } else {
    plates.push(boxFaces(gx, gy, fp, fp, s.height(n)));
  }
  const foot = project(gx + fp / 2, gy + fp);
  out.push({
    id: n.id, name: n.name, code: codeOf(n.name), kind: n.kind, path: n.path,
    summary: n.summary, status: n.status, section: n.section, pillar: n.pillar,
    degree: s.degree(n.id), flows, plates,
    centre: plates[plates.length - 1].centre,
    foot: { x: foot.x, y: foot.y + 12 },
    depth: gx + gy,
  });
}
