// glidepathDraw — the two pieces of geometry that decide whether the chart can
// be READ.
//
// jsdom draws no pixels and measures no glyphs, which is exactly why both of
// these are pure functions over numbers: the overshoot of a curve and the
// overlap of a label stack are arithmetic, and arithmetic can be asserted.

import { describe, expect, it } from 'vitest';
import { layoutLabels, monotonePath, type Point } from '../components/glidepathDraw';

/** Every coordinate a path string mentions, in order. */
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** Only the y values: the path is written x,y x,y ... after the leading M. */
const ys = (d: string) => numbers(d).filter((_, i) => i % 2 === 1);

describe('monotonePath — a curve that cannot claim more than the readings do', () => {
  it('draws nothing for no points, and a bare move for one', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 3, y: 4 }])).toBe('M3,4');
  });

  it('starts and ends exactly ON the first and last reading', () => {
    const pts: Point[] = [
      { x: 0, y: 100 },
      { x: 10, y: 80 },
      { x: 20, y: 30 },
    ];
    const d = monotonePath(pts);
    expect(d.startsWith('M0,100')).toBe(true);
    expect(d.endsWith('20,30')).toBe(true);
  });

  it('NEVER OVERSHOOTS a rise — the reason it is not a Catmull-Rom', () => {
    // An ordinary spline through a flat run and then a jump bulges ABOVE the
    // jump's own value, which on this chart would draw a usage line claiming a
    // percentage no reading recorded. Fritsch-Carlson cannot: every control
    // point stays inside the values it sits between.
    const pts: Point[] = [
      { x: 0, y: 200 },
      { x: 10, y: 200 },
      { x: 20, y: 100 },
      { x: 30, y: 20 },
    ];
    const all = ys(monotonePath(pts));
    // y counts DOWN the screen, so "never above the highest reading" is a
    // minimum on y.
    expect(Math.min(...all)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...all)).toBeLessThanOrEqual(200);
  });

  it('stays FLAT where the readings are flat', () => {
    const flat: Point[] = [0, 10, 20, 30].map((x) => ({ x, y: 50 }));
    expect(new Set(ys(monotonePath(flat)))).toEqual(new Set([50]));
  });

  it('survives two readings at the same x without emitting NaN', () => {
    // Two samples inside the same millisecond is a zero-width segment; a naive
    // tangent divides by it. Every number in the path must still be finite,
    // because one NaN silently drops the whole line from the SVG.
    const d = monotonePath([
      { x: 5, y: 10 },
      { x: 5, y: 20 },
      { x: 40, y: 30 },
    ]);
    expect(d).not.toMatch(/NaN|Infinity/);
    for (const n of numbers(d)) expect(Number.isFinite(n)).toBe(true);
  });
});

describe('layoutLabels — five bunched connections stay readable', () => {
  const slots = (...values: number[]) => values.map((y) => ({ y, ly: y }));

  it('pushes a bunched stack apart to the minimum gap', () => {
    // Five connections between 10% and 20% used put five labels inside twenty
    // pixels: one illegible smear exactly where the numbers matter.
    const items = slots(100, 102, 104, 106, 108);
    layoutLabels(items, 14, 0, 400);
    const sorted = items.map((i) => i.ly).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(14 - 1e-9);
  });

  it('keeps the whole stack INSIDE the plot, top and bottom', () => {
    // Pushing down to make room can push the last label off the bottom; the
    // second pass shifts the block back up and re-separates UPWARD, which is the
    // step that is easy to forget and re-creates the overlap it just removed.
    const items = slots(390, 392, 394, 396, 398);
    layoutLabels(items, 14, 40, 400);
    const sorted = items.map((i) => i.ly).sort((a, b) => a - b);
    expect(sorted[0]!).toBeGreaterThanOrEqual(40);
    expect(sorted[sorted.length - 1]!).toBeLessThanOrEqual(400);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(14 - 1e-9);
  });

  it('does the same when the stack is crushed against the TOP', () => {
    const items = slots(42, 43, 44);
    layoutLabels(items, 14, 40, 400);
    const sorted = items.map((i) => i.ly).sort((a, b) => a - b);
    expect(sorted[0]!).toBeGreaterThanOrEqual(40);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(14 - 1e-9);
  });

  it('leaves labels that are already clear exactly where they were', () => {
    const items = slots(60, 120, 200);
    layoutLabels(items, 14, 40, 400);
    expect(items.map((i) => i.ly)).toEqual([60, 120, 200]);
  });

  it('returns the array in the CALLER’s order, so the pairing survives', () => {
    // The caller holds a lane beside each slot; sorting in place would put the
    // wrong name on the wrong line.
    const items = [
      { id: 'a', y: 300, ly: 300 },
      { id: 'b', y: 100, ly: 100 },
      { id: 'c', y: 101, ly: 101 },
    ];
    const out = layoutLabels(items, 14, 40, 400);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]!.ly).toBe(300);
    expect(out[2]!.ly - out[1]!.ly).toBeGreaterThanOrEqual(14 - 1e-9);
  });

  it('an empty list is not a crash', () => {
    expect(layoutLabels([], 14, 40, 400)).toEqual([]);
  });
});
