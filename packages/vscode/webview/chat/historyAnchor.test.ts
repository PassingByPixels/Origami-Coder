// historyAnchor.test.ts — computeHistoryPlacement is the whole load-bearing
// contract HistoryDropdown.svelte trusts to keep its overlay both anchored
// (t-hb1o0e acceptance #1/#2) and bounded to the viewport (acceptance #3).
// jsdom has no layout, so this is tested as a pure function against fake
// rects and viewport heights — no render involved.
import { describe, it, expect } from 'vitest';
import { computeHistoryPlacement, type AnchorRect } from './historyAnchor';

describe('computeHistoryPlacement — anchors directly under the toolbar, at its width', () => {
  it('top sits a small gap below the anchor bottom, left/width copy the anchor exactly', () => {
    const anchor: AnchorRect = { top: 40, left: 12, width: 260, bottom: 76 };
    const p = computeHistoryPlacement(anchor, 900);

    expect(p.left).toBe(12);
    expect(p.width).toBe(260);
    expect(p.top).toBeGreaterThan(anchor.bottom); // below the toolbar, not over it
    expect(p.top).toBeLessThan(anchor.bottom + 20); // a small gap, not a big offset
  });

  it('a wider or narrower toolbar changes the overlay width one-for-one', () => {
    const narrow = computeHistoryPlacement({ top: 0, left: 0, width: 180, bottom: 30 }, 900);
    const wide = computeHistoryPlacement({ top: 0, left: 0, width: 420, bottom: 30 }, 900);

    expect(narrow.width).toBe(180);
    expect(wide.width).toBe(420);
  });
});

describe('computeHistoryPlacement — height is bounded by the space to the window bottom edge', () => {
  it('maxHeight is (viewport height - top - a bottom margin), never the list content height', () => {
    const anchor: AnchorRect = { top: 40, left: 0, width: 260, bottom: 76 };
    const p = computeHistoryPlacement(anchor, 400);

    expect(p.maxHeight).toBe(400 - p.top - 8);
  });

  it('an anchor near the bottom of a short viewport leaves little room, and that room shrinks as the viewport does', () => {
    const anchor: AnchorRect = { top: 500, left: 0, width: 260, bottom: 540 };
    const short = computeHistoryPlacement(anchor, 560);
    const shorter = computeHistoryPlacement(anchor, 548);

    expect(shorter.maxHeight).toBeLessThan(short.maxHeight);
  });

  it('never goes negative when the anchor is at or past the bottom of the viewport', () => {
    const anchor: AnchorRect = { top: 780, left: 0, width: 260, bottom: 820 };
    const p = computeHistoryPlacement(anchor, 800);

    expect(p.maxHeight).toBe(0);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
