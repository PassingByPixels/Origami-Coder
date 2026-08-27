// The isometric map's GEOMETRY — the camera (isoProject.ts), the FLOW-SPINE
// floor plan (isoLayout.ts) and the connectors (isoWires.ts). All three are
// pure, and all three are here because the bugs they can carry are precisely the
// ones no screenshot shows:
//
//  - a flipped axis sign still draws a perfectly plausible diagram, mirrored;
//  - boxes emitted out of painter's order still draw, with the far ones on top;
//  - a component reached by two flows drawn TWICE still looks like a map — one
//    with a phantom component in it, which is worse than a missing one;
//  - a node no flow touches quietly dropped, because the streets are built from
//    the flows and the districts are what catches the rest;
//  - a layout that is not a pure function of the map, so the static artifact and
//    the in-editor screen slowly stop agreeing about where anything is.
//
// The last one is the reason this module exists at all: ONE layout is computed
// host-side and serialized into both renderers, so "same map, same numbers" is
// the contract that replaces a mirrored module and its drift guard.

import { describe, expect, it } from 'vitest';
import { boundsOf, boxFaces, project, polyPoints, HX, HY, ZH } from '../../../src/dashboard/agentManager/isoProject';
import { codeOf, groupNodes, layoutMap } from '../../../src/dashboard/agentManager/isoLayout';
import { arcOf } from '../../../src/dashboard/agentManager/isoWires';
import type { MapFlow, MapNode, RepoMap } from '../../../src/dashboard/agentManager/mapSchema';

function node(id: string, pillar: number, extra: Partial<MapNode> = {}): MapNode {
  return { id, name: id, pillar, kind: 'module', summary: `${id} does a thing`, ...extra };
}
function flow(id: string, ...steps: string[]): MapFlow {
  return { id, name: id, description: `${id} runs`, steps: steps.map((s) => ({ node: s, note: `via ${s}` })) };
}

function map(overrides: Partial<RepoMap> = {}): RepoMap {
  return {
    version: 2,
    name: 'demo',
    summary: 'a fixture app',
    nodes: [node('a', 1), node('b', 2), node('c', 5)],
    edges: [{ from: 'a', to: 'b', label: 'calls' }],
    flows: [flow('boot', 'a', 'b')],
    keyFiles: [],
    conventions: [],
    ...overrides,
  };
}

/** Two flows that overlap, plus components no flow mentions — the shape the
 *  whole plan is built around, small enough to reason about by hand. */
const SPINE = map({
  nodes: [node('a', 1), node('b', 2), node('c', 2), node('d', 3), node('e', 5), node('f', 4, { section: 'Infra' })],
  edges: [{ from: 'a', to: 'b', label: 'calls' }],
  flows: [flow('one', 'a', 'b', 'a', 'c'), flow('two', 'b', 'd')],
});

describe('the isometric camera', () => {
  it('sends x down-RIGHT, y down-LEFT and z straight UP', () => {
    // A sign flip here mirrors the whole diagram and still looks like a diagram,
    // so the three axes are pinned to hand-computed numbers rather than to each
    // other. z must SUBTRACT from screen y: SVG y grows downward, so a positive
    // height has to move the point up the screen or every box sinks into its own
    // floor and the "3D" reads as a flat rhombus.
    expect(project(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(project(1, 0, 0)).toEqual({ x: HX, y: HY });
    expect(project(0, 1, 0)).toEqual({ x: -HX, y: HY });
    expect(project(0, 0, 1)).toEqual({ x: 0, y: -ZH });
  });

  it('projects whole cells to exact integers, so the two renderers agree byte for byte', () => {
    for (const [x, y, z] of [[3, 7, 2], [12, 1, 5], [0, 20, 4]]) {
      const p = project(x, y, z);
      expect(Number.isInteger(p.x), `x=${p.x}`).toBe(true);
      expect(Number.isInteger(p.y), `y=${p.y}`).toBe(true);
    }
  });

  it('snaps a FRACTIONAL cell to two decimals instead of trailing float noise', () => {
    // The flow-spine plan works in fractional cells (0.6 gaps, an 8.5 street
    // pitch), so (0.1+0.2)*HX-style residue would otherwise reach both artifacts
    // as `...00000000003` and bloat every polygon in them.
    const p = project(0.1 + 0.2, 0);
    expect(p.x).toBe(7.8);
    expect(String(project(8.5, 0).y)).toBe('110.5');
  });

  it('stands a box UP: every top-face corner sits above the base it rises from', () => {
    const f = boxFaces(0, 0, 2, 2, 3);
    expect(f.right[0].y).toBeLessThan(f.right[3].y);
    expect(f.right[1].y).toBeLessThan(f.right[2].y);
    expect(f.left[0].y).toBeLessThan(f.left[3].y);
  });

  it('joins its three faces at the front corner instead of leaving a seam', () => {
    const f = boxFaces(2, 5, 3, 3, 4);
    expect(f.top[2]).toEqual(f.right[1]);
    expect(f.top[2]).toEqual(f.left[1]);
    expect(f.right[2]).toEqual(f.left[2]);
  });

  it('gives an EMPTY point set a usable box rather than NaN', () => {
    const b = boundsOf([], 10);
    expect(Number.isFinite(b.x) && Number.isFinite(b.w)).toBe(true);
    expect(b.w).toBe(20);
  });

  it('formats a polygon one way for both renderers', () => {
    expect(polyPoints([{ x: 1, y: 2 }, { x: -3, y: 4 }])).toBe('1,2 -3,4');
  });
});

describe('the component badge', () => {
  it('takes the initials of the first two words, splitting on punctuation too', () => {
    expect(codeOf('Map Runner')).toBe('MR');
    expect(codeOf('repo-map/schema')).toBe('RM');
  });

  it('falls back to the first two letters of a single word', () => {
    expect(codeOf('mapSchema')).toBe('MA');
  });

  it('does not cut an astral character in half', () => {
    expect(codeOf('中🚀')).toBe('中🚀');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(codeOf('中🚀'))).toBe(false);
    expect(codeOf('架构')).toBe('架构');
  });

  it('never returns an empty badge', () => {
    expect(codeOf('   ')).toBe('?');
    expect(codeOf('')).toBe('?');
  });
});

describe('grouping puts every node in exactly one group', () => {
  const nodes = [
    node('a', 1, { section: 'CLI Tools' }),
    node('b', 1),
    node('c', 1, { section: '' }),
    node('d', 1, { section: 'Adapters' }),
    node('e', 2),
  ];

  it('leads with the UNGROUPED nodes, then the sections in name order', () => {
    const g = groupNodes(nodes, 1);
    expect(g.map((pack) => pack.map((n) => n.id))).toEqual([['b', 'c'], ['d'], ['a']]);
  });

  it('renders every node of a pillar exactly once', () => {
    const flat = groupNodes(nodes, 1).flat().map((n) => n.id);
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops nothing and invents nothing for a pillar with no nodes', () => {
    expect(groupNodes(nodes, 4)).toEqual([]);
  });
});

describe('the flow spine: one street per flow', () => {
  const L = layoutMap(SPINE);
  const at = (id: string) => L.boxes.find((b) => b.id === id)!;

  it('lays each flow FLAT: every component of one flow shares a depth, so it reads as a row', () => {
    // This IS the thesis. Streets run along the (+1,-1) diagonal, where x+y is
    // constant, and x+y projects straight to screen y. Break the placement to
    // (base+off, base+off) and these depths fan out — the picture still draws,
    // and the "read it end to end" property is silently gone.
    expect([at('a').depth, at('b').depth, at('c').depth]).toEqual([0, 0, 0]);
    expect(at('d').depth).toBe(17);          // street 2 = 2 * 8.5
    // ...and it is a SCREEN row, not just an equal number: the three captions sit
    // on one horizontal line. (Top faces do not — box height is flow count, so a
    // busier component stands taller out of the same ground row.)
    expect([at('b').foot.y, at('c').foot.y]).toEqual([at('a').foot.y, at('a').foot.y]);
  });

  it('stacks the streets DOWN the screen, in flow order', () => {
    const streets = L.zones.filter((z) => z.kind === 'street');
    expect(streets.map((z) => z.flow)).toEqual([0, 1]);
    expect(streets[1].poly[0].y).toBeGreaterThan(streets[0].poly[0].y);
    expect(streets[0].count).toBe(3);        // a, b, c live on street one
    expect(streets[1].count).toBe(1);        // only d is new to street two
  });

  it('gives a component reached by TWO flows to the FIRST street, and draws it once', () => {
    // `b` is step 2 of flow one and step 1 of flow two. Drawn on both streets it
    // would be a phantom component: two boxes, one id, and every count wrong.
    expect(L.boxes.filter((b) => b.id === 'b')).toHaveLength(1);
    expect(at('b').depth).toBe(at('a').depth);
  });

  it('draws a REVISITED node once and keeps its FIRST step number', () => {
    // Flow one is a -> b -> a -> c. The schema has no revisit marker, so the
    // renderer de-duplicates by id; the badge must stay on the first visit or the
    // reader is told the path starts at step 3.
    const trace = L.flowPaths[0];
    expect(trace.marks.map((m) => m.n)).toEqual([1, 2, 4]);
    expect(trace.segs).toHaveLength(3);      // four steps, three hops — the return IS drawn
  });

  it('draws every node exactly once, whether a flow touches it or not', () => {
    const ids = L.boxes.map((b) => b.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('the flow spine: what the flows never touch', () => {
  const L = layoutMap(SPINE);

  it('docks an untouched component in ITS pillar district, below the last street', () => {
    const lastStreet = Math.max(...L.boxes.filter((b) => ['a', 'b', 'c', 'd'].includes(b.id)).map((b) => b.depth));
    for (const id of ['e', 'f']) {
      const box = L.boxes.find((b) => b.id === id)!;
      expect(box.depth, `${id} should dock below the streets`).toBeGreaterThan(lastStreet);
    }
    const districts = L.zones.filter((z) => z.kind === 'district');
    expect(districts.map((z) => z.pillar).sort()).toEqual([4, 5]);
    expect(districts.every((z) => z.count === 1)).toBe(true);
  });

  it('captions each section block inside a district', () => {
    const labels = L.sectionLabels.map((s) => `${s.section} ${s.count}`).sort();
    expect(labels).toEqual(['(ungrouped) 1', 'Infra 1']);
  });

  it('raises NO district for a pillar whose components all live on a street', () => {
    // Pillars 1-3 are fully covered by the two flows here. An empty district
    // would be a labelled, dashed rectangle containing nothing.
    expect(L.zones.filter((z) => z.kind === 'district' && [1, 2, 3].includes(z.pillar))).toEqual([]);
  });

  it('docks EVERYTHING when the map records no flows at all', () => {
    const l = layoutMap(map({ flows: [] }));
    expect(l.zones.filter((z) => z.kind === 'street')).toEqual([]);
    expect(l.boxes).toHaveLength(3);
    expect(l.boxes.every((b) => Number.isFinite(b.depth))).toBe(true);
    expect(Number.isFinite(l.view.w) && l.view.w > 0).toBe(true);
  });
});

describe('the layout is a pure function of the map', () => {
  it('gives byte-identical geometry for the same map, twice', () => {
    // This is the whole reason the layout is computed once and serialized: the
    // static map.html and the in-editor screen must place every box in the same
    // spot, and they only can if this is deterministic — including the district
    // packing, which is a SEARCH over orderings and wrap widths.
    expect(JSON.stringify(layoutMap(SPINE))).toBe(JSON.stringify(layoutMap(SPINE)));
  });

  it('emits boxes in PAINTER order, back to front', () => {
    // SVG has no depth buffer. Out of order, a box behind is drawn last and
    // covers the box in front of it — which reads as a rendering glitch, not as
    // a sorting bug, so it is easy to chase for a long time.
    const depths = layoutMap(SPINE).boxes.map((b) => b.depth);
    expect([...depths].sort((x, y) => x - y)).toEqual(depths);
  });
});

describe('the layout reads the map for its shapes', () => {
  it('makes a well-connected node bigger than an isolated one', () => {
    const m = map({
      nodes: [node('hub', 2), node('lonely', 2), node('x', 2), node('y', 2), node('z', 2)],
      edges: [
        { from: 'hub', to: 'x', label: '' }, { from: 'hub', to: 'y', label: '' },
        { from: 'hub', to: 'z', label: '' }, { from: 'x', to: 'y', label: '' },
      ],
      flows: [],
    });
    const boxes = new Map(layoutMap(m).boxes.map((b) => [b.id, b]));
    const width = (id: string): number => {
      const t = boxes.get(id)!.plates[0].top;
      return Math.max(...t.map((p) => p.x)) - Math.min(...t.map((p) => p.x));
    };
    expect(boxes.get('hub')!.degree).toBe(3);
    expect(boxes.get('lonely')!.degree).toBe(0);
    expect(width('hub')).toBeGreaterThan(width('lonely'));
  });

  it('gives a KEY FILE a floor on its footprint, so the map\'s own picks are not leaf-sized', () => {
    // 31 of the 63 nodes in the reference map have degree 0, so degree alone is
    // a flat signal and the seven files the map calls important vanish into it.
    const m = map({
      nodes: [node('key', 2, { path: 'src/core.ts' }), node('plain', 2, { path: 'src/other.ts' })],
      edges: [], flows: [], keyFiles: [{ path: 'src/core.ts', why: 'the contract' }],
    });
    const boxes = new Map(layoutMap(m).boxes.map((b) => [b.id, b]));
    const span = (id: string): number => {
      const t = boxes.get(id)!.plates[0].top;
      return Math.max(...t.map((p) => p.x)) - Math.min(...t.map((p) => p.x));
    };
    expect(span('key')).toBeGreaterThan(span('plain'));
  });

  it('draws pillar 5 (Artifacts & Outputs) as a STACK and everything else as one solid', () => {
    const l = layoutMap(map());
    const byId = new Map(l.boxes.map((b) => [b.id, b]));
    expect(byId.get('c')!.pillar).toBe(5);
    expect(byId.get('c')!.plates.length).toBeGreaterThan(1);
    expect(byId.get('a')!.plates).toHaveLength(1);
    expect(byId.get('b')!.plates).toHaveLength(1);
  });

  it('survives a map with no nodes, edges or flows at all', () => {
    const l = layoutMap(map({ nodes: [], edges: [], flows: [] }));
    expect(l.boxes).toEqual([]);
    expect(l.zones).toEqual([]);
    expect(Number.isFinite(l.view.w) && l.view.w > 0).toBe(true);
  });
});

describe('the connectors', () => {
  it('stops each end short of the box centre and points the head at the TARGET', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const g = arcOf(a, b)!;
    expect(g.s.x).toBeGreaterThan(a.x);         // clear of the solid it leaves
    expect(g.e.x).toBeLessThan(b.x);            // and of the one it arrives at
    expect(g.head[0]).toEqual(g.e);             // the tip IS the arrival point
    expect(g.head[1].x).toBeLessThan(g.e.x);    // the two barbs trail behind it
    expect(g.head[2].x).toBeLessThan(g.e.x);
  });

  it('bows to ONE side, so the two directions of a mutual dependency stay apart', () => {
    const there = arcOf({ x: 0, y: 0 }, { x: 200, y: 0 })!;
    const back = arcOf({ x: 200, y: 0 }, { x: 0, y: 0 })!;
    expect(Math.sign(there.c.y - 0)).toBe(-Math.sign(back.c.y - 0));
  });

  it('returns NOTHING for a zero-length edge instead of a NaN arrowhead', () => {
    // Two nodes at the same point is not hypothetical: a self-edge validates.
    expect(arcOf({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });

  it('joins each edge between the two boxes it names', () => {
    const l = layoutMap(map());
    expect(l.links).toHaveLength(1);
    expect(l.links[0].from).toBe('a');
    expect(l.links[0].to).toBe('b');
    expect(Number.isFinite(l.links[0].c.x)).toBe(true);
  });
});
