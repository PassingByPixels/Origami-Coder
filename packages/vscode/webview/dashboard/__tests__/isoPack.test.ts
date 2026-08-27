// The packing search behind the map's pillar districts. It earns its own file
// because it is the one part of the floor plan that is a SEARCH — it tries many
// orderings and many wrap widths and keeps the best — and a search can be wrong
// in ways a picture never shows: it can silently return the first thing it tried,
// it can drop an item that did not fit, and it can return a different answer on
// the second call and make the two renderers disagree.

import { describe, expect, it } from 'vitest';
import { bestPack, orderings, shelfPack } from '../../../src/dashboard/agentManager/isoPack';

const box = (w: number, d = w): { w: number; d: number } => ({ w, d });

describe('shelf packing', () => {
  it('wraps to a new shelf when the next item would pass the target width', () => {
    const r = shelfPack([box(3), box(3), box(3)], 7, 1);
    expect(r.placed.map((p) => [p.x, p.y])).toEqual([[0, 0], [4, 0], [0, 4]]);
    expect(r.w).toBe(7);
    expect(r.d).toBe(7);
  });

  it('places an item WIDER than the target rather than looping or dropping it', () => {
    // One very wide section is an ordinary map. If the first item on a shelf were
    // subject to the wrap test it would wrap forever, or be skipped and vanish.
    const r = shelfPack([box(9), box(2)], 4, 1);
    expect(r.placed).toHaveLength(2);
    expect(r.placed[1].y).toBeGreaterThan(0); // the narrow one went to the next shelf
    expect(r.w).toBe(9);
  });

  it('places every item exactly once, whatever the target', () => {
    const items = [box(2), box(4), box(3), box(2), box(5)];
    for (const t of [2, 5, 9, 40]) {
      expect(shelfPack(items, t, 0.5).placed.map((p) => p.it)).toEqual(items);
    }
  });
});

describe('the ordering search', () => {
  it('is exhaustive while that is cheap, and bounded after', () => {
    // 6 items = 720 orders is the point the mockup drew the line at, and every
    // pillar in the reference map has fewer sections than that.
    expect(orderings([box(1), box(2), box(3)])).toHaveLength(6);
    expect(orderings([1, 2, 3, 4, 5, 6].map((n) => box(n)))).toHaveLength(720);
    expect(orderings([1, 2, 3, 4, 5, 6, 7].map((n) => box(n)))).toHaveLength(6);
  });

  it('returns the same candidate list every time it is asked', () => {
    const items = [box(3, 1), box(3, 2), box(1, 5), box(4, 4), box(2, 2), box(6, 1), box(1, 1)];
    expect(JSON.stringify(orderings(items))).toBe(JSON.stringify(orderings(items)));
  });
});

describe('bestPack', () => {
  it('returns an empty packing of zero extent for an empty bag', () => {
    // A pillar every flow already covers has nothing left to dock. That is an
    // ordinary map, and a degenerate 1x1 packing would draw a stray district.
    expect(bestPack([], 1)).toEqual({ placed: [], w: 0, d: 0 });
  });

  it('beats the naive single-row packing on W + D, which IS the picture size', () => {
    // An iso W x D rectangle projects to (W+D)*HX by (W+D)*HY px, so W+D is the
    // drawing's size. Six 3-cell squares in one row measure 3 + 23 = 26; the
    // search must find something squarer than that.
    const items = [box(3), box(3), box(3), box(3), box(3), box(3)];
    const naive = shelfPack(items, 999, 1);
    const best = bestPack(items, 1);
    expect(naive.w + naive.d).toBe(26);
    expect(best.w + best.d).toBeLessThan(naive.w + naive.d);
    expect(best.placed).toHaveLength(6);
  });

  it('biases WIDE when asked to, so the district slab sits under the streets', () => {
    // Eight 2-cell squares: the square-biased search settles on 3 rows (7 x 7),
    // the wide-biased one on 2 rows of 4 (9.5 x 4.5). Same items, same W+D, a
    // different SHAPE — which is the whole reason the knob exists.
    const items = [2, 2, 2, 2, 2, 2, 2, 2].map((n) => box(n));
    const square = bestPack(items, 0.5, 1);
    const wide = bestPack(items, 0.5, 2.5);
    expect([square.w, square.d]).toEqual([7, 7]);
    expect(wide.w).toBeGreaterThan(square.w);
    expect(wide.d).toBeLessThan(square.d);
  });

  it('is deterministic — the same bag packs to the same coordinates twice', () => {
    // The whole "one layout, two renderers" contract rests on this.
    const items = [box(2, 3), box(4, 1), box(1, 1), box(3, 3), box(2, 2), box(5, 2), box(1, 4)];
    expect(JSON.stringify(bestPack(items, 1, 2))).toBe(JSON.stringify(bestPack(items, 1, 2)));
  });
});
