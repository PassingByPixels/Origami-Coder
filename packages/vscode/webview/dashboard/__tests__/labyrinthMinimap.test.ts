// Corridor as a MINIMAP. The defining claim is "the whole run, at once, with
// no scrolling" — so the assertions here are about the claim, not about the
// arithmetic that currently satisfies it:
//
//  - EVERY marker, plus its own radius, lands inside a canvas that does NOT
//    grow with the run. A test that only checked centres would pass while the
//    outermost dots bled over the edge, and a test that only checked one size
//    would miss the whole point — so it is asserted at four run lengths, 336
//    among them (the run the owner actually looked at).
//  - the snake still reverses each row (corridor's identity),
//  - a delegated stretch is a NESTED chamber, not steps queued inline with the
//    main thread — the failure that killed the previous corridor.

import { describe, it, expect } from 'vitest';
import {
  minimapLayout, MINIMAP_WIDTH, MINIMAP_HEIGHT,
  corridorLayout, viewBoxFor, isThreshold, type LayoutStep,
} from '../components/labyrinthLayout';
import { kindMark, markSize, markX, MARK_CHAR_W } from '../components/labyrinthMarks';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, ...over,
});
const many = (n: number, over: (i: number) => Partial<LayoutStep> = () => ({})): LayoutStep[] =>
  Array.from({ length: n }, (_, i) => step(i, over(i)));

/** The four sizes: a short run, the two the brief names, and a 400 overshoot. */
const SIZES = [20, 100, 336, 400];

describe('the minimap FITS — the whole run on one screen, never a scroll', () => {
  it.each(SIZES)('every marker of a %i-step run is inside the viewBox, radius and all', (n) => {
    const box = viewBoxFor('corridor', n);
    const map = minimapLayout(many(n));
    expect(map.points).toHaveLength(n);
    for (const p of map.points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r)).toBe(true);
      expect(p.r).toBeGreaterThan(0);
      expect(p.x - p.r, `marker ${p.step.ordinal} bleeds off the left`).toBeGreaterThanOrEqual(0);
      expect(p.x + p.r, `marker ${p.step.ordinal} bleeds off the right`).toBeLessThanOrEqual(box.width);
      expect(p.y - p.r, `marker ${p.step.ordinal} bleeds off the top`).toBeGreaterThanOrEqual(0);
      expect(p.y + p.r, `marker ${p.step.ordinal} bleeds off the bottom`).toBeLessThanOrEqual(box.height);
    }
  });

  it('the canvas is FIXED — 20 steps and 400 steps get the SAME box, and the markers shrink instead', () => {
    // This is the inversion the mode was rebuilt for: the old corridor grew a
    // taller canvas per row and the pane scrolled, so a long run was never
    // visible at once. A minimap that grows is not a minimap.
    for (const n of SIZES) {
      expect(viewBoxFor('corridor', n)).toEqual({ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT });
    }
    const small = minimapLayout(many(20));
    const large = minimapLayout(many(400));
    expect(large.points[0]!.r).toBeLessThan(small.points[0]!.r);
    expect(large.rows).toBeGreaterThan(small.rows);
    expect(large.cols).toBeGreaterThan(small.cols);
  });

  it('a chamber-heavy run still fits — reserved cells are counted before the rows are', () => {
    // 300 steps, most of them delegated in long stretches: the chambers push
    // rows around, so the row count cannot be read off the step count alone.
    const steps = many(300, (i) => (i % 30 === 0
      ? { kind: 'subagent' as const }
      : { kind: 'reply' as const, depth: 1, parentOrdinal: Math.floor(i / 30) * 30 }));
    const map = minimapLayout(steps);
    for (const p of map.points) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(0);
      expect(p.x + p.r).toBeLessThanOrEqual(MINIMAP_WIDTH);
      expect(p.y - p.r).toBeGreaterThanOrEqual(0);
      expect(p.y + p.r).toBeLessThanOrEqual(MINIMAP_HEIGHT);
    }
    for (const c of map.chambers) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(MINIMAP_WIDTH);
      expect(c.y + c.h).toBeLessThanOrEqual(MINIMAP_HEIGHT);
    }
  });

  it('0 and 1 steps degrade without dividing by zero', () => {
    const empty = minimapLayout([]);
    expect(empty.points).toEqual([]);
    expect(empty.chambers).toEqual([]);
    const one = minimapLayout([step(0)]);
    expect(one.points).toHaveLength(1);
    expect(Number.isFinite(one.points[0]!.x)).toBe(true);
    expect(one.points[0]!.r).toBeGreaterThan(0);
  });
});

// The owner's UAT: corridor's SHAPE was right but every dot looked alike, so
// you could see that something happened without seeing WHAT. A one-character
// kind mark rides the main thread. The claims worth pinning are that it never
// costs the fit the mode is built on, that it stays off the chamber cells
// (whose density is the whole reason chambers exist), and that it is dropped
// rather than drawn illegibly once the cells get too small.
describe('a main-thread marker SAYS what it was', () => {
  it.each(SIZES)('at %i steps, every mark ends inside the canvas — the fit is not spent on labels', (n) => {
    const map = minimapLayout(many(n));
    const size = markSize(Math.min(map.cellW, map.rowH));
    expect(size, `a ${n}-step run should still have room for a mark`).toBeGreaterThan(0);
    for (const p of map.points) {
      if (p.chamber >= 0) continue;
      const end = markX(p.x, p.r) + size * MARK_CHAR_W;
      expect(end, `the mark on marker ${p.step.ordinal} bleeds off the right`).toBeLessThanOrEqual(MINIMAP_WIDTH);
      expect(markX(p.x, p.r)).toBeGreaterThan(p.x);
    }
  });

  it('a mark never reaches its neighbour cell — it labels ONE marker, not the gap', () => {
    const map = minimapLayout(many(336));
    const size = markSize(Math.min(map.cellW, map.rowH));
    const widest = Math.max(...map.points.map((p) => markX(p.x, p.r) - p.x)) + size * MARK_CHAR_W;
    expect(widest).toBeLessThan(map.cellW - Math.max(...map.points.map((p) => p.r)));
  });

  it('the canvas got TALLER and the cells got BIGGER with it — the point of the raise', () => {
    // Height, not width: more rows' worth of room means FEWER, WIDER columns at
    // the same step count, which is what buys the space the mark needs.
    expect(MINIMAP_HEIGHT).toBeGreaterThan(MINIMAP_WIDTH / 2);
    const map = minimapLayout(many(336));
    expect(map.cellW).toBeGreaterThan(30); // was 27.54 on the 420-high canvas
    expect(map.points[0]!.r).toBeGreaterThan(6);
  });

  it('each kind gets its OWN mark, and an unknown kind gets none rather than a wrong one', () => {
    const marks = (['prompt', 'reply', 'tool', 'thinking', 'subagent', 'error'] as const).map(kindMark);
    expect(new Set(marks).size, `${marks.join('')} has a collision`).toBe(marks.length);
    expect(marks.every((m) => m.length === 1)).toBe(true);
    expect(kindMark('teleport' as LayoutStep['kind'])).toBe('');
  });

  it('a FAILED tool keeps the tool mark — only its tone changes, as everywhere else', () => {
    // The shape is the raw kind's; the failure is carried by the tone class and
    // the enlarged radius. A mark that flipped to "!" would hide what failed.
    expect(kindMark('tool')).toBe(kindMark('tool'));
    const failed = minimapLayout([step(0, { kind: 'tool', status: 'error' })]);
    expect(kindMark(failed.points[0]!.step.kind)).toBe(kindMark('tool'));
    expect(isThreshold(failed.points[0]!.step)).toBe(true);
  });

  it('below a legible size the mark is DROPPED, not shrunk into a smear', () => {
    expect(markSize(40)).toBeGreaterThan(0);
    expect(markSize(22)).toBeGreaterThan(0);
    expect(markSize(19)).toBe(0);
    expect(markSize(4)).toBe(0);
    // ...and that really happens on a run big enough to cause it.
    const huge = minimapLayout(many(1200));
    expect(markSize(Math.min(huge.cellW, huge.rowH))).toBe(0);
  });
});

describe('the snake still reverses — corridor keeps its identity', () => {
  const rowsOf = (pts: Array<{ x: number; y: number }>) =>
    [...new Set(pts.map((p) => p.y))].sort((a, b) => a - b).map((y) => pts.filter((p) => p.y === y));

  it.each([30, 100, 336])('at %i steps, every even row ascends in x and every odd row descends', (n) => {
    const rows = rowsOf(corridorLayout(many(n)));
    expect(rows.length).toBeGreaterThan(2);
    rows.forEach((row, r) => {
      for (let i = 1; i < row.length; i++) {
        if (r % 2 === 0) expect(row[i]!.x).toBeGreaterThan(row[i - 1]!.x);
        else expect(row[i]!.x).toBeLessThan(row[i - 1]!.x);
      }
    });
  });

  it('the walk TURNS at each row end instead of jumping the full width back', () => {
    const map = minimapLayout(many(336));
    const { cols } = map;
    for (let turn = cols; turn < map.points.length; turn += cols) {
      expect(map.points[turn]!.x).toBeCloseTo(map.points[turn - 1]!.x, 6);
      expect(map.points[turn]!.y).toBeGreaterThan(map.points[turn - 1]!.y);
    }
  });
});

describe('a sub-agent is an inset CHAMBER, not steps queued inline', () => {
  // The previous corridor had nowhere to put a branch — a snake spends both
  // axes on sequence — so delegated steps were drawn in the main run's cells
  // with only a colour to tell them apart. This is that failure, pinned.
  const DELEGATED = [
    step(0, { kind: 'prompt', title: 'audit the repo' }),
    step(1, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
    ...Array.from({ length: 9 }, (_, i) =>
      step(2 + i, { kind: 'reply', title: `child ${i}`, depth: 1, parentOrdinal: 1 })),
    step(11, { kind: 'reply', title: 'here is what it found' }),
  ];

  it('the delegated steps form ONE nested group, and the main thread none', () => {
    const map = minimapLayout(DELEGATED);
    expect(map.chambers).toHaveLength(1);
    expect(map.chambers[0]!.count).toBe(9);
    expect(map.chambers[0]!.key).toBe(2); // the first delegated step's index
    const inside = map.points.filter((p) => p.chamber >= 0).map((p) => p.step.ordinal);
    expect(inside).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const i of [0, 1, 11]) expect(map.points[i]!.chamber).toBe(-1);
  });

  it('every delegated marker sits INSIDE its chamber rect, and no main-thread one does', () => {
    const map = minimapLayout(DELEGATED);
    const c = map.chambers[0]!;
    const within = (p: { x: number; y: number }) =>
      p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
    for (const p of map.points.filter((q) => q.chamber >= 0)) expect(within(p)).toBe(true);
    for (const i of [0, 1, 11]) expect(within(map.points[i]!)).toBe(false);
  });

  it('a delegated marker is NOT on a main-thread cell centre — it is nested, not inline', () => {
    const map = minimapLayout(DELEGATED);
    const trailY = new Set(map.trail.map((t) => t.y));
    const child = map.points[5]!;
    // Inline would mean sharing the corridor's own row centre AND its radius.
    expect(trailY.has(child.y)).toBe(false);
    expect(child.r).toBeLessThan(map.points[0]!.r);
    // ...and the corridor line itself skips them: it walks the main run only.
    expect(map.trail).toHaveLength(3);
  });

  it('the chamber hangs at the SPAWN — it starts no earlier than the spawning step', () => {
    const map = minimapLayout(DELEGATED);
    const spawn = map.points[1]!;
    const c = map.chambers[0]!;
    expect(c.x + c.w).toBeGreaterThan(spawn.x);
    expect(Math.abs(c.y + c.h / 2 - spawn.y)).toBeLessThanOrEqual(map.rowH);
  });

  it('two separate delegations are two separate chambers, never merged into one', () => {
    const steps = [
      step(0, { kind: 'subagent', tool: 'task' }),
      step(1, { kind: 'reply', depth: 1, parentOrdinal: 0 }),
      step(2, { kind: 'reply', depth: 1, parentOrdinal: 0 }),
      step(3, { kind: 'reply', title: 'back on the trunk' }),
      step(4, { kind: 'subagent', tool: 'task' }),
      step(5, { kind: 'reply', depth: 1, parentOrdinal: 4 }),
    ];
    const map = minimapLayout(steps);
    expect(map.chambers.map((c) => c.count)).toEqual([2, 1]);
    expect(new Set(map.points.filter((p) => p.chamber >= 0).map((p) => p.chamber)).size).toBe(2);
  });

  it('a run with NO delegation draws no chambers at all — the block means something', () => {
    expect(minimapLayout(many(40)).chambers).toEqual([]);
    expect(minimapLayout(many(40)).points.every((p) => p.chamber === -1)).toBe(true);
  });
});

describe('a failure is obvious without reading anything', () => {
  it('a failed step is drawn LARGER than the completed steps around it', () => {
    const steps = many(60, (i) => (i === 33 ? { status: 'error' as const } : { status: 'completed' as const }));
    const map = minimapLayout(steps);
    const failed = map.points[33]!;
    expect(isThreshold(steps[33]!)).toBe(true);
    for (const [i, p] of map.points.entries()) {
      if (i === 33) continue;
      expect(failed.r).toBeGreaterThan(p.r);
    }
  });

  it('a failure INSIDE a chamber is still enlarged relative to its siblings', () => {
    const steps = [
      step(0, { kind: 'subagent', tool: 'task' }),
      ...Array.from({ length: 6 }, (_, i) =>
        step(1 + i, { kind: 'reply', depth: 1, parentOrdinal: 0, status: i === 3 ? 'error' : 'completed' })),
    ];
    const map = minimapLayout(steps);
    expect(map.points[4]!.r).toBeGreaterThan(map.points[3]!.r);
  });

  it('a step with no status at all is drawn at the ordinary size — absent is not failed', () => {
    const map = minimapLayout([step(0), step(1, { status: 'completed' })]);
    expect(map.points[0]!.r).toBe(map.points[1]!.r);
  });
});
