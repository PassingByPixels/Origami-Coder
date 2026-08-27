// THREAD'S VERTICAL AXIS IS TIME — the defect this round exists for.
//
// The regression, from a real captured run: ordinals 0-1 are main-thread, 2
// spawns a sub-agent and 3-7 are its steps, 8 spawns another and 9-13 are its
// steps, 14 spawns a third and 15-19 are its steps — and only THEN come the
// main-thread turns the user actually took while all three were still working.
// `run_steps` inlines a child's steps after its spawn, so stacking by list
// index drew those turns at the bottom, reading as "after all three finished".
// They were concurrent.
//
// Every test here asserts the REQUIREMENT — is an earlier step ever below a
// later one, does a turn taken mid-branch land inside that branch's extent,
// does an untimed run degrade to exactly today's rows and say so — rather than
// pixel arithmetic, so the constants can still move.

import { describe, it, expect } from 'vitest';
import {
  threadLayout, threadBranchPaths, threadIsTimeBased, threadRows,
  layoutFor, viewBoxFor, type LayoutStep,
} from '../components/labyrinthLayout';
import { mapNotice } from '../components/labyrinthNotice';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal,
  kind: 'reply',
  title: `step ${ordinal}`,
  ...over,
});

/**
 * The owner's run, compressed but structurally faithful: three sub-agents
 * spawned back to back, each one's steps inlined immediately after it, and
 * three main-thread turns (14/15/16) that all began in the first two seconds —
 * i.e. WHILE every branch was still working. Sub-agent #1 is the short one
 * (2 min); #2 and #3 run on for another three minutes after it returned.
 */
const OWNERS_RUN: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'write three war stories while we talk', startedAt: 0 }),
  step(1, { kind: 'thinking', title: 'Thinking', startedAt: 100 }),
  step(2, { kind: 'subagent', tool: 'task', title: 'war story #1', background: true, status: 'completed', startedAt: 200, endedAt: 120_200 }),
  step(3, { kind: 'prompt', title: 'brief #1', depth: 1, parentOrdinal: 2, startedAt: 210 }),
  step(4, { kind: 'thinking', title: 'Thinking', depth: 1, parentOrdinal: 2, startedAt: 60_000 }),
  step(5, { kind: 'reply', title: 'story #1', depth: 1, parentOrdinal: 2, startedAt: 119_000 }),
  step(6, { kind: 'subagent', tool: 'task', title: 'war story #2', background: true, status: 'completed', startedAt: 400, endedAt: 300_400 }),
  step(7, { kind: 'prompt', title: 'brief #2', depth: 1, parentOrdinal: 6, startedAt: 410 }),
  step(8, { kind: 'thinking', title: 'Thinking', depth: 1, parentOrdinal: 6, startedAt: 150_000 }),
  step(9, { kind: 'reply', title: 'story #2', depth: 1, parentOrdinal: 6, startedAt: 299_000 }),
  step(10, { kind: 'subagent', tool: 'task', title: 'war story #3', background: true, status: 'completed', startedAt: 600, endedAt: 280_600 }),
  step(11, { kind: 'prompt', title: 'brief #3', depth: 1, parentOrdinal: 10, startedAt: 610 }),
  step(12, { kind: 'thinking', title: 'Thinking', depth: 1, parentOrdinal: 10, startedAt: 140_000 }),
  step(13, { kind: 'reply', title: 'story #3', depth: 1, parentOrdinal: 10, startedAt: 279_000 }),
  step(14, { kind: 'reply', title: 'Three agents writing now', startedAt: 800 }),
  step(15, { kind: 'prompt', title: 'List all capitals of europe', startedAt: 1_000 }),
  step(16, { kind: 'reply', title: 'Albania — Tirana …', startedAt: 1_200 }),
];

/** The three main-thread turns that ran DURING the sub-agents. */
const CONCURRENT_TURNS = [14, 15, 16];
const yOf = (steps: LayoutStep[], i: number) => threadLayout(steps)[i]!.y;
/** The y a rail's merge segment leaves the branch column at. */
const mergeY = (path: string) => Number(path.match(/M [\d.-]+ ([\d.-]+)/)![1]);

describe('a main-thread turn taken DURING a branch is drawn beside it, not below it', () => {
  it('every concurrent turn lands INSIDE the vertical extent of every branch it overlapped', () => {
    const rails = threadBranchPaths(OWNERS_RUN);
    expect(rails).toHaveLength(3);

    for (const rail of rails) {
      const spawn = OWNERS_RUN[rail.first]!;
      const headY = yOf(OWNERS_RUN, rail.first);
      for (const i of CONCURRENT_TURNS) {
        const turn = OWNERS_RUN[i]!;
        // It really did run inside this branch's span — that is the premise.
        expect(turn.startedAt!).toBeGreaterThan(spawn.startedAt!);
        expect(turn.startedAt!).toBeLessThan(spawn.endedAt!);
        // ...so it must be drawn between the departure and the merge. Stacking
        // by list index puts it below the merge of the SHORT branch (#1),
        // which is the screenshot the owner filed.
        expect(yOf(OWNERS_RUN, i), `turn ${i} is above branch ${rail.first}'s departure`)
          .toBeGreaterThan(headY);
        expect(yOf(OWNERS_RUN, i), `turn ${i} is drawn BELOW branch ${rail.first}'s merge — it reads as "after"`)
          .toBeLessThanOrEqual(rail.endY);
      }
    }
  });

  it('and it sits ABOVE the delegated steps that started after it', () => {
    // The other half of the same fact: a child step that began two minutes in
    // belongs below a main-thread turn taken at 0.8s, whatever the list says.
    for (const later of [4, 5, 8, 9, 12, 13]) {
      for (const i of CONCURRENT_TURNS) {
        expect(yOf(OWNERS_RUN, i), `step ${later} started after turn ${i} but is drawn above it`)
          .toBeLessThan(yOf(OWNERS_RUN, later));
      }
    }
  });

  it('the branches still keep their own columns — this moved rows, not lanes', () => {
    const rails = threadBranchPaths(OWNERS_RUN);
    expect(new Set(rails.map((r) => r.x)).size).toBe(3);
    const pts = threadLayout(OWNERS_RUN);
    // Each spawn and its three children share one x...
    for (const [spawn, kids] of [[2, [3, 4, 5]], [6, [7, 8, 9]], [10, [11, 12, 13]]] as const) {
      for (const kid of kids) expect(pts[kid]!.x).toBe(pts[spawn]!.x);
    }
    // ...and the main thread is on one spine of its own.
    expect(new Set([0, 1, 14, 15, 16].map((i) => pts[i]!.x)).size).toBe(1);
  });

  it('a rail merges below the LAST ROW it outlived, not the last list position', () => {
    // Branch #1 returned at 120_200. Steps 8/9/12/13 all started later, so a
    // list walk stops at 8 — but on a time axis the rows those steps occupy are
    // below rows that DO belong to the span. The merge must clear the latter.
    const [first] = threadBranchPaths(OWNERS_RUN);
    for (const i of [...CONCURRENT_TURNS, 4, 5]) {
      expect(mergeY(first!.merge!), `branch #1 merged above step ${i}, which ran before it returned`)
        .toBeGreaterThanOrEqual(yOf(OWNERS_RUN, i));
    }
    expect(mergeY(first!.merge!)).toBeLessThan(yOf(OWNERS_RUN, 9)); // ...and not past what it did not
  });
});

describe('rows are monotonic in startedAt — never an earlier step below a later one', () => {
  it('holds for every pair in the owner’s run', () => {
    const pts = threadLayout(OWNERS_RUN);
    for (let a = 0; a < OWNERS_RUN.length; a++) {
      for (let b = 0; b < OWNERS_RUN.length; b++) {
        if (OWNERS_RUN[a]!.startedAt! < OWNERS_RUN[b]!.startedAt!) {
          expect(pts[a]!.y, `step ${a} started before ${b} but is drawn below it`).toBeLessThan(pts[b]!.y);
        }
      }
    }
  });

  it('equal timestamps keep list order rather than shuffling', () => {
    const tied = [step(0, { startedAt: 5 }), step(1, { startedAt: 5 }), step(2, { startedAt: 9 })];
    const pts = threadLayout(tied);
    expect(pts[0]!.y).toBeLessThan(pts[1]!.y);
    expect(pts[1]!.y).toBeLessThan(pts[2]!.y);
  });

  it('every marker still lands inside the thread viewBox', () => {
    const box = viewBoxFor('thread', OWNERS_RUN.length);
    for (const p of threadLayout(OWNERS_RUN)) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(box.height);
    }
  });
});

describe('the axis is RANK — real durations never scale it', () => {
  it('a five-minute step beside a 7ms one keeps a uniform pitch and stays on canvas', () => {
    const wild: LayoutStep[] = [
      step(0, { kind: 'tool', tool: 'read', startedAt: 1_000_000 }),
      step(1, { kind: 'tool', tool: 'read', startedAt: 1_000_007 }),   // +7ms
      step(2, { kind: 'reply', startedAt: 1_300_007 }),                // +5 minutes
      step(3, { kind: 'reply', startedAt: 1_300_014 }),                // +7ms again
    ];
    const pts = threadLayout(wild);
    const gaps = pts.slice(1).map((p, i) => p.y - pts[i]!.y);
    // A literal time scale would make gap 2 forty-thousand times gap 1.
    for (const g of gaps) expect(g).toBe(gaps[0]);
    expect(gaps[0]).toBeGreaterThan(0);
    const box = viewBoxFor('thread', wild.length);
    for (const p of pts) expect(p.y).toBeLessThanOrEqual(box.height);
  });

  it('the canvas is exactly as tall as the same run stacked by index', () => {
    const timed = Array.from({ length: 40 }, (_, i) => step(i, { startedAt: i * (i % 3 === 0 ? 90_000 : 3) }));
    const untimed = Array.from({ length: 40 }, (_, i) => step(i));
    const span = (s: LayoutStep[]) => {
      const ys = threadLayout(s).map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(timed)).toBe(span(untimed));
  });
});

describe('an incomplete clock degrades to list order — and says so', () => {
  const HOLED = OWNERS_RUN.map((s, i) => (i === 8 ? { ...s, startedAt: undefined } : s));

  it('ONE missing start falls the WHOLE view back to index rows', () => {
    expect(threadIsTimeBased(OWNERS_RUN)).toBe(true);
    expect(threadIsTimeBased(HOLED)).toBe(false);
    expect(threadRows(HOLED)).toBeNull();
    const pts = threadLayout(HOLED);
    // Index stacking: strictly one row per list position, in list order.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.y - pts[i - 1]!.y).toBe(pts[1]!.y - pts[0]!.y);
    // ...and it is byte-identical to the same run with no clocks at all.
    const bare = HOLED.map(({ startedAt, endedAt, durationMs, ...rest }) => rest);
    expect(threadLayout(HOLED).map((p) => p.y)).toEqual(threadLayout(bare).map((p) => p.y));
  });

  it('the pane is told to SAY it, in thread as well as in flight', () => {
    const note = mapNotice('thread', HOLED);
    expect(note).not.toBeNull();
    expect(note!).toContain('ORDER, not time');
    expect(note!.toLowerCase()).toContain('list order');
    // No claim is made when the clock IS complete...
    expect(mapNotice('thread', OWNERS_RUN)).toBeNull();
    // ...and corridor, which never claimed time, says nothing either way.
    expect(mapNotice('corridor', HOLED)).toBeNull();
    expect(mapNotice('corridor', OWNERS_RUN)).toBeNull();
  });

  it('a partly-timed run is never partly positioned — no invented rows', () => {
    // The one that matters: the timed steps must NOT keep their clock rows
    // while the untimed one is slotted in by index. That mixes recorded
    // positions with invented ones, which reads as timing we do not have.
    const half = [
      step(0, { startedAt: 9_000 }),
      step(1),
      step(2, { startedAt: 1_000 }),
    ];
    const pts = threadLayout(half);
    expect(pts[0]!.y).toBeLessThan(pts[2]!.y); // list order, though 2 is earlier
    expect(mapNotice('thread', half)).not.toBeNull();
  });
});

describe('clocks the engine could plausibly hand us that do not add up', () => {
  it('a child whose clock post-dates its parent’s return never drags the merge ABOVE the spine', () => {
    // Contradictory data, not a licence to draw backwards: the rail must still
    // run head -> last -> merge downward, or it renders as a line through itself.
    const skewed: LayoutStep[] = [
      step(0, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 100, endedAt: 200 }),
      step(1, { kind: 'reply', title: 'late child', depth: 1, parentOrdinal: 0, startedAt: 9_000 }),
      step(2, { kind: 'reply', title: 'main', startedAt: 150 }),
    ];
    const [b] = threadBranchPaths(skewed);
    const pts = threadLayout(skewed);
    expect(b!.merge).not.toBeNull();
    expect(mergeY(b!.merge!)).toBeGreaterThanOrEqual(pts[1]!.y); // never above its own last step
    expect(b!.trail).toBeNull();                                 // and no in-flight stretch invented
  });

  it('a run where every step shares ONE timestamp degrades rather than claiming an order', () => {
    const flat = [step(0, { startedAt: 42 }), step(1, { startedAt: 42 }), step(2, { startedAt: 42 })];
    expect(threadIsTimeBased(flat)).toBe(false);
    expect(mapNotice('thread', flat)).not.toBeNull();
    const ys = threadLayout(flat).map((p) => p.y);
    expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
    expect(ys[0]!).toBeLessThan(ys[1]!);
  });

  it('a non-finite start is treated as missing, not sorted as a number', () => {
    for (const startedAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const junk = [step(0, { startedAt: 1 }), step(1, { startedAt }), step(2, { startedAt: 3 })];
      expect(threadRows(junk)).toBeNull();
      expect(threadLayout(junk).every((p) => Number.isFinite(p.y))).toBe(true);
    }
  });
});

describe('the other two modes are untouched by the clock', () => {
  it('corridor still snakes by INDEX — the compact view never claimed time', () => {
    const timed = layoutFor('corridor', OWNERS_RUN);
    const untimed = layoutFor('corridor', OWNERS_RUN.map(({ startedAt, endedAt, ...rest }) => rest));
    expect(timed.map((p) => [p.x, p.y])).toEqual(untimed.map((p) => [p.x, p.y]));
    expect(mapNotice('corridor', OWNERS_RUN)).toBeNull();
  });

  it('flight still places by x and still says nothing when it can', () => {
    const pts = layoutFor('flight', OWNERS_RUN);
    // The main thread stays one band and each of the three concurrent
    // sub-agents takes a SWIMLANE of its own below it (labyrinthSwim.ts) —
    // they overlapped in time, so one shared row would hide that...
    expect(new Set([0, 1, 14, 15, 16].map((i) => pts[i]!.y)).size).toBe(1);
    expect(new Set([2, 6, 10].map((i) => pts[i]!.y)).size).toBe(3);
    for (const i of [2, 6, 10]) expect(pts[i]!.y).toBeGreaterThan(pts[0]!.y);
    // ...and x is still genuinely proportional to the clock.
    const span = pts[9]!.x - pts[0]!.x; // 0 -> 299_000ms, the widest pair
    expect(span).toBeGreaterThan(0);
    expect((pts[14]!.x - pts[0]!.x) / span).toBeCloseTo(800 / 299_000, 5);
    expect(mapNotice('flight', OWNERS_RUN)).toBeNull();
  });
});

describe('an OLD engine binary — no timestamps at all — renders exactly as before', () => {
  const OLD: LayoutStep[] = [
    step(0, { kind: 'prompt', title: 'audit the repo' }),
    step(1, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
    step(2, { kind: 'prompt', title: 'audit brief', depth: 1, parentOrdinal: 1 }),
    step(3, { kind: 'reply', title: 'audit findings', depth: 1, parentOrdinal: 1 }),
    step(4, { kind: 'reply', title: 'here is what it found' }),
  ];

  it('rows are the list positions, evenly pitched, strictly downward', () => {
    const ys = threadLayout(OLD).map((p) => p.y);
    const pitch = ys[1]! - ys[0]!;
    expect(pitch).toBeGreaterThan(0);
    expect(ys).toEqual(ys.map((_, i) => ys[0]! + i * pitch));
  });

  it('its branch still departs, runs its spine and merges at its own last step', () => {
    const [b] = threadBranchPaths(OLD);
    expect(b!.open).toBe(false);
    expect(b!.spine).not.toBeNull();
    expect(b!.trail).toBeNull();
    expect(mergeY(b!.merge!)).toBe(yOf(OLD, 3));
  });

  it('a single-step run and an empty run still lay out', () => {
    expect(threadLayout([])).toEqual([]);
    expect(threadLayout([step(0, { startedAt: 7 })])).toHaveLength(1);
    expect(threadRows([step(0, { startedAt: 7 })])).toBeNull(); // one point orders nothing
  });
});
