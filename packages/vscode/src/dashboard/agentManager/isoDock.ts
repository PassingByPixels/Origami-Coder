// THE DOCK: everything the flows never mention, packed into pillar districts and
// dropped below the last street.
//
// This is the other half of the flow-spine plan (isoLayout.ts owns the streets),
// and it is the half with a search in it: nodes pack into a section block, blocks
// pack into a district, districts pack into one slab — three nested calls to
// isoPack's W+D minimisation, the last biased WIDE so the slab sits under the
// streets rather than beside them.
//
// Its own file because it is the part that grows: a new grouping rule, a new
// ordering, a different bias all land here, while the streets stay as they are.

import { HX, project, tileOutline } from './isoProject';
import { bestPack } from './isoPack';
import { emit, type IsoBox, type Sizes } from './isoBox';
import type { IsoSectionLabel, IsoZone } from './isoLayout';
import { PILLARS, type MapNode, type RepoMap } from './mapSchema';

/** Cells between docked boxes, between section blocks, between districts. */
const GAP = 0.6;
const BLOCK_GAP = 1.4;
const DIST_GAP = 2.0;
/** Padding inside a section block, and inside a district. */
const SPAD = 0.6;
const ZPAD = 1.0;
/** Grid steps between one street and the next — the dock has to clear them all. */
const STREET_PITCH = 8.5;
/** Grid steps below the last street where the slab starts: enough to clear the
 *  tallest box standing on that street. */
const DOCK_CLEAR = 17;

/** Ungrouped nodes first, then each section in name order. A blank `section` is
 *  not a section named "" — an unsectioned node must still get a home. */
export function groupNodes(nodes: readonly MapNode[], pillar: number): MapNode[][] {
  const mine = nodes.filter((n) => n.pillar === pillar);
  const named = (n: MapNode): string => (n.section && n.section.trim() !== '' ? n.section : '');
  const bare = mine.filter((n) => named(n) === '');
  const sections = [...new Set(mine.map(named).filter((s) => s !== ''))].sort();
  return [bare, ...sections.map((s) => mine.filter((n) => named(n) === s))].filter((g) => g.length > 0);
}

/** The same grouping, captioned — the district blocks are labelled on screen. */
function sectionsOf(nodes: readonly MapNode[], pillar: number): Array<{ name: string; nodes: MapNode[] }> {
  return groupNodes(nodes, pillar).map((pack) => {
    const s = pack[0].section;
    return { name: s && s.trim() !== '' ? s.trim() : '(ungrouped)', nodes: pack };
  });
}

/** Pack and place the off-flow components. Appends to the three output lists and
 *  returns nothing — a map whose flows already cover everything simply adds no
 *  district, which is an ordinary map rather than an error. */
export function dockDistricts(
  map: RepoMap, s: Sizes, placed: ReadonlySet<string>, spanX: readonly number[],
  boxes: IsoBox[], zones: IsoZone[], labels: IsoSectionLabel[],
): void {
  const slabs = [];
  for (const p of PILLARS) {
    const blocks = [];
    for (const sec of sectionsOf(map.nodes, p.number)) {
      const rest = sec.nodes.filter((n) => !placed.has(n.id));
      if (rest.length === 0) continue;
      const items = rest.map((n) => ({ w: s.fp(n), d: s.fp(n), n }))
        .sort((a, b) => b.w - a.w || a.n.id.localeCompare(b.n.id));
      const pk = bestPack(items, GAP, 1);
      blocks.push({ w: pk.w + SPAD * 2, d: pk.d + SPAD * 2, pk, name: sec.name, count: rest.length });
    }
    if (blocks.length === 0) continue;
    blocks.sort((a, b) => b.d - a.d || b.w - a.w || a.name.localeCompare(b.name));
    const zp = bestPack(blocks, BLOCK_GAP, 1);
    slabs.push({
      w: zp.w + ZPAD * 2, d: zp.d + ZPAD * 2, zp, pillar: p.number,
      count: blocks.reduce((t, b) => t + b.count, 0),
    });
  }
  if (slabs.length === 0) return;
  slabs.sort((a, b) => b.w * b.d - a.w * a.d || a.pillar - b.pillar);
  const dp = bestPack(slabs, DIST_GAP, 2.0);

  // Drop the slab below the last street and centre it on them. `dif` converts a
  // screen-x offset back into the grid's (x - y), which is the only axis a
  // horizontal shift has in this projection.
  const sum = 2 * (map.flows.length - 1) * STREET_PITCH + DOCK_CLEAR;
  const cx = spanX.length > 0 ? (Math.min(...spanX) + Math.max(...spanX)) / 2 : 0;
  const dif = cx / HX - dp.w / 2 + dp.d / 2;
  const dx = (sum + dif) / 2;
  const dy = (sum - dif) / 2;

  for (const slot of dp.placed) {
    const d = slot.it;
    const zx = dx + slot.x;
    const zy = dy + slot.y;
    const top = project(zx, zy);
    zones.push({
      kind: 'district', flow: -1, pillar: d.pillar, poly: tileOutline(zx, zy, d.w, d.d),
      count: d.count, label: { x: top.x, y: top.y - 16 }, anchor: 'middle', depth: zx + zy - 0.5,
    });
    for (const bslot of d.zp.placed) {
      const b = bslot.it;
      const bx = zx + ZPAD + bslot.x;
      const by = zy + ZPAD + bslot.y;
      const bt = project(bx, by);
      labels.push({ section: b.name, count: b.count, at: { x: bt.x, y: bt.y - 5 } });
      for (const nslot of b.pk.placed) emit(nslot.it.n, bx + SPAD + nslot.x, by + SPAD + nslot.y, s, boxes);
    }
  }
}
