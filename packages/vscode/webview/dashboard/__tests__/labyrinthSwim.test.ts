// FLIGHT AS A SWIMLANE BOARD — the round this file exists for.
//
// The regression: every sub-agent was drawn on ONE delegation row, so two
// tasks backgrounded together produced two bars stacked exactly on top of each
// other. Flight is the only view positioned by wall clock, i.e. the only one
// where concurrency can be shown honestly — and it was the one throwing that
// fact away. Each branch now takes its own lane, and two runs that shared a
// minute genuinely share a stretch of x.
//
// Every test asserts the REQUIREMENT — is the overlap visible, is a lane given
// back once its branch merged, does a lane end where the sub-agent actually
// returned rather than at its last child step — not the pixel arithmetic, so
// the constants can still move. THREAD is signed off and is pinned byte for
// byte against output captured before any of this landed.

import { describe, it, expect } from 'vitest';
import {
  flightSpans, swimLayout, swimBox, swimClockY, swimLaneCount, swimLaneTags, swimCrowded,
  swimCaptionHidden, swimClockHidden,
  threadLayout, threadBranchPaths, viewBoxFor, layoutFor, flightDetail,
  MAX_BRANCH_COLUMNS, FLIGHT_BASE_Y, type LayoutStep,
} from '../components/labyrinthLayout';
import { mapNotice } from '../components/labyrinthNotice';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal, kind: 'reply', title: `step ${ordinal}`, ...over,
});

/**
 * Two tasks backgrounded within a tenth of a second of each other, both still
 * working while the user carried on talking. #1 returns at 120_200 and #2 at
 * 300_400, so their extents genuinely OVERLAP — exactly the fact the old single
 * delegation row could not draw.
 */
const CONCURRENT: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'write two stories while we talk', startedAt: 0 }),
  step(1, { kind: 'subagent', tool: 'task', title: 'story #1', background: true, status: 'completed', startedAt: 200, endedAt: 120_200 }),
  step(2, { kind: 'reply', title: 'story #1 text', depth: 1, parentOrdinal: 1, startedAt: 119_000 }),
  step(3, { kind: 'subagent', tool: 'task', title: 'story #2', background: true, status: 'completed', startedAt: 400, endedAt: 300_400 }),
  step(4, { kind: 'reply', title: 'story #2 text', depth: 1, parentOrdinal: 3, startedAt: 299_000 }),
  step(5, { kind: 'reply', title: 'two agents writing now', startedAt: 800 }),
  step(6, { kind: 'prompt', title: 'capitals of europe', startedAt: 1_000 }),
];

const laneOf = (steps: LayoutStep[], i: number) => swimLayout(steps)[i]!.y;
const xOf = (steps: LayoutStep[], i: number) => swimLayout(steps)[i]!.x;
const barFor = (steps: LayoutStep[], index: number) => flightSpans(steps).find((s) => s.index === index)!;

describe('two sub-agents that ran at the same time get two lanes', () => {
  it('their lanes are DIFFERENT rows and their x ranges genuinely overlap', () => {
    const one = barFor(CONCURRENT, 1);
    const two = barFor(CONCURRENT, 3);
    // Different rows — the whole point. One row would stack them invisibly.
    expect(one.y).not.toBe(two.y);
    // ...and both below the main line, which is where delegation lives.
    expect(one.y).toBeGreaterThan(FLIGHT_BASE_Y);
    expect(two.y).toBeGreaterThan(FLIGHT_BASE_Y);
    // The overlap is real: each starts before the other ends.
    expect(one.x1).toBeLessThan(two.x2);
    expect(two.x1).toBeLessThan(one.x2);
    expect(Math.min(one.x2, two.x2) - Math.max(one.x1, two.x1)).toBeGreaterThan(0);
  });

  it('each sub-agent’s own steps sit on ITS lane, not on a shared delegation row', () => {
    expect(laneOf(CONCURRENT, 2)).toBe(laneOf(CONCURRENT, 1)); // child of #1
    expect(laneOf(CONCURRENT, 4)).toBe(laneOf(CONCURRENT, 3)); // child of #2
    expect(laneOf(CONCURRENT, 2)).not.toBe(laneOf(CONCURRENT, 4));
    // ...and the main thread is still one line of its own.
    expect(new Set([0, 5, 6].map((i) => laneOf(CONCURRENT, i))).size).toBe(1);
    expect(laneOf(CONCURRENT, 0)).toBe(FLIGHT_BASE_Y);
  });

  it('each lane DEPARTS the main line where it was spawned and REJOINS where it returned', () => {
    for (const index of [1, 3]) {
      const bar = barFor(CONCURRENT, index);
      const depart = bar.depart.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!;
      expect(Number(depart[1])).toBeCloseTo(bar.x1, 2);   // at the spawn's x...
      expect(Number(depart[2])).toBe(FLIGHT_BASE_Y);      // ...off the main line
      expect(Number(depart[4])).toBe(bar.y);              // ...onto its own lane
      const rejoin = bar.rejoin!.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!;
      expect(Number(rejoin[1])).toBeCloseTo(bar.x2, 2);   // where it reported back
      expect(Number(rejoin[2])).toBe(bar.y);
      expect(Number(rejoin[4])).toBe(FLIGHT_BASE_Y);      // ...back to the main line
    }
  });
});

describe('a lane ends where the sub-agent RETURNED, not at its last child step', () => {
  it('the bar starts at the spawn’s x and outruns the child’s last step', () => {
    const bar = barFor(CONCURRENT, 1);
    expect(bar.x1).toBeCloseTo(xOf(CONCURRENT, 1), 5); // the spawn, at 200ms
    // The child's last step began at 119_000; the sub-agent returned at
    // 120_200. Ending the lane at the child would shorten it by that stretch —
    // and for a DETACHED run the child's last step is not evidence of anything.
    expect(bar.x2).toBeGreaterThan(xOf(CONCURRENT, 2));
  });

  it('...but never PAST the axis: a run that outlived the last recorded start is clamped', () => {
    // #2 returned at 300_400, later than every startedAt in the run. The scale
    // is built from starts, so it has no x of its own; drawing it beyond the
    // last marker would be an extrapolation the run never recorded.
    const bar = barFor(CONCURRENT, 3);
    const rightmost = Math.max(...swimLayout(CONCURRENT).map((p) => p.x));
    expect(bar.x2).toBeCloseTo(rightmost, 5);
    expect(bar.x2).toBeGreaterThan(barFor(CONCURRENT, 1).x2);
  });

  it('a main-thread turn taken DURING a sub-agent falls inside that lane’s span', () => {
    const one = barFor(CONCURRENT, 1);
    for (const i of [5, 6]) { // 800ms and 1_000ms, both while #1 worked
      expect(xOf(CONCURRENT, i)).toBeGreaterThan(one.x1);
      expect(xOf(CONCURRENT, i)).toBeLessThan(one.x2);
    }
  });
});

describe('a lane is GIVEN BACK once its branch merged', () => {
  const SEQUENTIAL: LayoutStep[] = [
    step(0, { kind: 'prompt', startedAt: 0 }),
    step(1, { kind: 'subagent', tool: 'task', title: 'first', status: 'completed', startedAt: 100, endedAt: 200 }),
    step(2, { kind: 'reply', depth: 1, parentOrdinal: 1, startedAt: 150 }),
    step(3, { kind: 'reply', title: 'first landed', startedAt: 300 }),
    step(4, { kind: 'subagent', tool: 'task', title: 'second', status: 'completed', startedAt: 400, endedAt: 500 }),
    step(5, { kind: 'reply', depth: 1, parentOrdinal: 4, startedAt: 450 }),
    step(6, { kind: 'reply', title: 'second landed', startedAt: 600 }),
  ];

  it('a later sub-agent REUSES the merged one’s lane instead of opening a new row', () => {
    expect(laneOf(SEQUENTIAL, 4)).toBe(laneOf(SEQUENTIAL, 1));
    expect(swimLaneCount(SEQUENTIAL)).toBe(1);
    // ...and the two bars share the row without overlapping in x.
    const [a, b] = flightSpans(SEQUENTIAL);
    expect(a!.y).toBe(b!.y);
    expect(a!.x2).toBeLessThanOrEqual(b!.x1);
  });

  it('25 sequential sub-agents still produce ONE lane, not 25', () => {
    const many: LayoutStep[] = [];
    for (let i = 0; i < 25; i++) {
      const at = i * 1_000;
      many.push(step(many.length, { kind: 'subagent', tool: 'task', status: 'completed', startedAt: at, endedAt: at + 100 }));
      many.push(step(many.length, { kind: 'reply', depth: 1, parentOrdinal: many.length - 1, startedAt: at + 50 }));
    }
    expect(swimLaneCount(many)).toBe(1);
    expect(new Set(flightSpans(many).map((s) => s.y)).size).toBe(1);
  });

  it('more concurrent branches than lanes FOLD instead of running off the canvas', () => {
    const swarm: LayoutStep[] = [step(0, { kind: 'prompt', startedAt: 0 })];
    for (let i = 0; i < MAX_BRANCH_COLUMNS + 3; i++) {
      swarm.push(step(swarm.length, {
        kind: 'subagent', tool: 'task', background: true, status: 'completed',
        startedAt: 100 + i, endedAt: 900_000,
      }));
    }
    swarm.push(step(swarm.length, { kind: 'reply', startedAt: 1_000_000 }));
    const lanes = swimLaneCount(swarm);
    expect(lanes).toBeLessThanOrEqual(MAX_BRANCH_COLUMNS);
    const box = swimBox(swarm.length, lanes);
    for (const p of swimLayout(swarm)) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(box.height);
      expect(p.x).toBeLessThanOrEqual(box.width);
    }
    // The clock row still clears the lowest lane it has to sit under.
    expect(swimClockY(lanes)).toBeGreaterThan(Math.max(...swimLayout(swarm).map((p) => p.y)));
    expect(swimClockY(lanes)).toBeLessThan(box.height);
  });
});

describe('a sub-agent that never came back keeps an OPEN lane', () => {
  const RUNNING = CONCURRENT.map((s, i) =>
    (i === 3 ? { ...s, status: 'running' as const, endedAt: undefined } : s));

  it('its lane reaches the right-hand edge and is never rejoined', () => {
    const open = barFor(RUNNING, 3);
    expect(open.open).toBe(true);
    expect(open.rejoin, 'a sub-agent that never returned must not be drawn rejoining').toBeNull();
    // The axis end: no laid-out marker sits right of where the lane stops.
    const rightmost = Math.max(...swimLayout(RUNNING).map((p) => p.x));
    expect(open.x2).toBeCloseTo(rightmost, 5);
    // ...and the sibling that DID return on the same run still rejoins.
    const closed = barFor(RUNNING, 1);
    expect(closed.open).toBe(false);
    expect(closed.rejoin).not.toBeNull();
    expect(closed.x2).toBeLessThan(open.x2);
  });
});

describe('no clock, no invented lengths — and the pane says so', () => {
  const UNTIMED = CONCURRENT.map(({ startedAt, endedAt, ...rest }) => rest);

  it('delegated steps still leave the main line — that much needs no clock', () => {
    expect(laneOf(UNTIMED, 1)).toBeGreaterThan(FLIGHT_BASE_Y);
    expect(laneOf(UNTIMED, 2)).toBe(laneOf(UNTIMED, 1)); // child on its parent's lane
    expect(laneOf(UNTIMED, 0)).toBe(FLIGHT_BASE_Y);
  });

  it('CONCURRENCY IS NOT INVENTED: with no clock the two share ONE lane, in sequence', () => {
    // The same two sub-agents get two lanes when the run's clock proves they
    // overlapped. Strip the clock and nothing proves it — list order says one
    // finished before the next began — so drawing them as parallel would be a
    // claim the run never made. Same lane is the honest answer, and this is
    // the assertion that stops flight reading concurrency out of list shape.
    expect(laneOf(UNTIMED, 3)).toBe(laneOf(UNTIMED, 1));
    expect(laneOf(CONCURRENT, 3)).not.toBe(laneOf(CONCURRENT, 1));
    expect(swimLaneCount(UNTIMED)).toBe(1);
    expect(swimLaneCount(CONCURRENT)).toBe(2);
  });

  it('but no bar, departure or rejoin is drawn, and the notice is raised', () => {
    expect(flightSpans(UNTIMED)).toEqual([]);
    expect(mapNotice('flight', UNTIMED)).toContain('ORDER, not time');
    expect(mapNotice('flight', CONCURRENT)).toBeNull();
  });

  it('a branch the engine sent as bare `depth` takes a lane but never a fabricated span', () => {
    const bare = [
      step(0, { kind: 'prompt', startedAt: 0 }),
      step(1, { kind: 'reply', depth: 1, startedAt: 100 }),
      step(2, { kind: 'reply', startedAt: 200 }),
    ];
    expect(laneOf(bare, 1)).toBeGreaterThan(FLIGHT_BASE_Y);
    expect(flightSpans(bare)).toEqual([]);
  });
});

describe('the strip drops detail it cannot print legibly', () => {
  it('two markers on top of each other lose their detail rows; a spaced one keeps them', () => {
    const packed: LayoutStep[] = [
      step(0, { kind: 'tool', tool: 'read', title: 'a', durationMs: 12, startedAt: 0 }),
      step(1, { kind: 'tool', tool: 'read', title: 'b', durationMs: 13, startedAt: 1 }),
      step(2, { kind: 'tool', tool: 'read', title: 'c', durationMs: 14, startedAt: 900_000 }),
    ];
    const crowded = swimCrowded(swimLayout(packed));
    expect(crowded[0]).toBe(true);
    expect(crowded[1]).toBe(true);
    expect(crowded[2], 'a step with room must keep the detail flight exists to show').toBe(false);
    // Dropped means dropped from the STRIP, not lost: the rows still exist.
    expect(flightDetail(packed[0]!).length).toBeGreaterThan(1);
  });

  it('steps on DIFFERENT lanes never crowd each other — only same-lane neighbours do', () => {
    const sameX: LayoutStep[] = [
      step(0, { kind: 'reply', startedAt: 0 }),
      step(1, { kind: 'subagent', tool: 'task', status: 'completed', startedAt: 1, endedAt: 2 }),
      step(2, { kind: 'reply', startedAt: 900_000 }),
    ];
    const crowded = swimCrowded(swimLayout(sameX));
    expect(crowded[0]).toBe(false); // main lane
    expect(crowded[1]).toBe(false); // delegation lane, at almost the same x
  });
});

// THE OWNER'S SCREENSHOT: two captions drawn straight through one another,
// reading "Write ta**sk**mpell…". swimCrowded gated the DETAIL rows and left
// the caption above them ungated. These assert the requirement — no two
// captions on a lane may share any x — rather than the arithmetic that
// currently satisfies it, so the caption width can still move.
describe('two captions are never drawn through each other', () => {
  /** Half the caption's real drawn width; it is anchored on its middle. */
  const halfWidth = (s: LayoutStep) => (Math.min((s.tool ?? s.title).length, 16) * 8.4) / 2;
  const overlaps = (steps: LayoutStep[]) => {
    const pts = swimLayout(steps);
    const hidden = swimCaptionHidden(pts);
    const shown = pts.map((p, i) => ({ ...p, i })).filter((p) => !hidden[p.i]);
    const clashes: string[] = [];
    for (const a of shown) {
      for (const b of shown) {
        if (a.i >= b.i || a.y !== b.y) continue;
        if (Math.abs(a.x - b.x) < halfWidth(a.step) + halfWidth(b.step)) clashes.push(`${a.i}/${b.i}`);
      }
    }
    return clashes;
  };

  /** Six tool calls inside a fifth of a second — the real shape of a tool burst. */
  const BURST: LayoutStep[] = [
    step(0, { kind: 'prompt', title: 'fix the failing suite', startedAt: 0 }),
    ...Array.from({ length: 6 }, (_, i) =>
      step(1 + i, { kind: 'tool', tool: `Write task_${i}.ts`, title: `write ${i}`, startedAt: 40 + i * 30 })),
    step(7, { kind: 'reply', title: 'all written', startedAt: 900_000 }),
  ];

  it('a burst of near-simultaneous steps yields NO overlapping caption', () => {
    // Without the rule every one of these prints, and they smear.
    expect(overlaps(BURST)).toEqual([]);
  });

  it('...and it really was a colliding density — the un-gated set DOES overlap', () => {
    // Guards the test itself: a fixture that never collided would let a broken
    // rule pass. This is the same measurement with nothing hidden.
    const pts = swimLayout(BURST);
    const clashes: string[] = [];
    for (const [i, a] of pts.entries()) {
      for (const [j, b] of pts.entries()) {
        if (i >= j || a.y !== b.y) continue;
        if (Math.abs(a.x - b.x) < halfWidth(a.step) + halfWidth(b.step)) clashes.push(`${i}/${j}`);
      }
    }
    expect(clashes.length).toBeGreaterThan(0);
  });

  it('DROPPING beats overlapping, but it drops the FEWEST it can — one of each pair survives', () => {
    const hidden = swimCaptionHidden(swimLayout(BURST));
    // A pairwise rule would take both halves of every clash and leave the
    // tool lane blank; the greedy one keeps an evenly sampled set.
    expect(hidden.filter((h) => !h).length).toBeGreaterThan(1);
    expect(hidden.some((h) => h)).toBe(true);
  });

  it('a step whose caption is dropped is NOT lost — it is still a step with a title', () => {
    const hidden = swimCaptionHidden(swimLayout(BURST));
    const dropped = BURST.filter((_, i) => hidden[i]);
    expect(dropped.length).toBeGreaterThan(0);
    for (const s of dropped) expect(s.title.length).toBeGreaterThan(0);
  });

  it('a well-spaced strip loses nothing at all — the rule means something', () => {
    const roomy = [
      step(0, { kind: 'reply', title: 'first', startedAt: 0 }),
      step(1, { kind: 'reply', title: 'second', startedAt: 500_000 }),
      step(2, { kind: 'reply', title: 'third', startedAt: 1_000_000 }),
    ];
    expect(swimCaptionHidden(swimLayout(roomy))).toEqual([false, false, false]);
  });

  it('captions on DIFFERENT lanes never collide — a lane is measured on its own', () => {
    const sameX: LayoutStep[] = [
      step(0, { kind: 'reply', title: 'on the trunk', startedAt: 0 }),
      step(1, { kind: 'tool', tool: 'read', title: 'a tool at the same instant', startedAt: 1 }),
      step(2, { kind: 'reply', title: 'later', startedAt: 900_000 }),
    ];
    expect(swimCaptionHidden(swimLayout(sameX))).toEqual([false, false, false]);
  });

  it('an empty strip and a single step degrade without touching anything', () => {
    expect(swimCaptionHidden([])).toEqual([]);
    expect(swimCaptionHidden(swimLayout([step(0, { title: 'alone' })]))).toEqual([false]);
  });
});

// THE OWNER'S SECOND SCREENSHOT: the clock row rendering "11:57:17:43
// 11:57:46" — two timestamps drawn straight through each other into nonsense.
// The caption round gated the CAPTIONS; the time axis is a different render
// path (LabyrinthNode draws it at swimClockY, off the marker's own lane) and
// was never covered. These assert the requirement — no two clocks printed on
// the axis may share any x — not the arithmetic that currently satisfies it.
describe('the TIME AXIS never draws two clocks through each other', () => {
  /** Half a "HH:MM:SS" label's real drawn width at the 11px clock size. */
  const CLOCK_HALF = (8 * 7.2) / 2;
  /** Which printed clocks overlap, given a hidden mask (all-false = ungated). */
  const clashes = (steps: LayoutStep[], hidden: boolean[]) => {
    const shown = swimLayout(steps)
      .map((p, i) => ({ x: p.x, i }))
      .filter((p) => !hidden[p.i] && steps[p.i]!.startedAt !== undefined);
    const out: string[] = [];
    for (const a of shown) {
      for (const b of shown) {
        if (a.i >= b.i) continue;
        if (Math.abs(a.x - b.x) < CLOCK_HALF * 2) out.push(`${a.i}/${b.i}`);
      }
    }
    return out;
  };

  /** A tool burst inside a fifth of a second, then a step ten minutes later. */
  const BURST: LayoutStep[] = [
    step(0, { kind: 'prompt', title: 'fix the failing suite', startedAt: 0 }),
    ...Array.from({ length: 6 }, (_, i) =>
      step(1 + i, { kind: 'tool', tool: `write_${i}`, title: `write ${i}`, startedAt: 40 + i * 30 })),
    step(7, { kind: 'reply', title: 'all written', startedAt: 900_000 }),
  ];

  it('a burst of near-simultaneous steps yields NO overlapping clock', () => {
    expect(clashes(BURST, swimClockHidden(swimLayout(BURST)))).toEqual([]);
  });

  it('...and it really was a colliding density — the un-gated set DOES overlap', () => {
    // Guards the test itself: a fixture that never collided would let a broken
    // rule pass. Same measurement, nothing hidden.
    expect(clashes(BURST, BURST.map(() => false)).length).toBeGreaterThan(0);
  });

  it('two steps sharing an IDENTICAL timestamp print ONE clock, not two on one spot', () => {
    // |dx| = 0, so no width and no shortening can separate them. Exactly one
    // of the pair may survive — the case a "shrink the label" rule fails at.
    const twins: LayoutStep[] = [
      step(0, { kind: 'reply', title: 'first', startedAt: 5_000 }),
      step(1, { kind: 'reply', title: 'same instant', startedAt: 5_000 }),
      step(2, { kind: 'reply', title: 'much later', startedAt: 900_000 }),
    ];
    expect(xOf(twins, 0)).toBe(xOf(twins, 1)); // precondition: one x, two steps
    const hidden = swimClockHidden(swimLayout(twins));
    expect(hidden.slice(0, 2).filter(Boolean)).toHaveLength(1);
    expect(hidden[2]).toBe(false);
  });

  it('the axis is ONE row — a trunk step and a tool at the same instant collide there, though their captions do not', () => {
    const sameX: LayoutStep[] = [
      step(0, { kind: 'reply', title: 'on the trunk', startedAt: 0 }),
      step(1, { kind: 'tool', tool: 'read', title: 'a tool at the same instant', startedAt: 1 }),
      step(2, { kind: 'reply', title: 'later', startedAt: 900_000 }),
    ];
    // Two lanes, so both captions print — that rule is per-lane and unchanged.
    expect(swimCaptionHidden(swimLayout(sameX))).toEqual([false, false, false]);
    // ...but every clock is drawn on the SAME line, so one of them must go.
    const hidden = swimClockHidden(swimLayout(sameX));
    expect(hidden.slice(0, 2).filter(Boolean)).toHaveLength(1);
  });

  it('a step with no timestamp prints no clock and RESERVES NO SPACE for one', () => {
    // A zero-width candidate that still took the slot would suppress the real
    // label beside it — an empty axis where one label was perfectly printable.
    expect(swimClockHidden([{ x: 0, step: {} }, { x: 1, step: { startedAt: 5_000 } }]))
      .toEqual([true, false]);
  });

  it('a well-spaced strip keeps every clock — the rule means something', () => {
    const roomy: LayoutStep[] = [
      step(0, { kind: 'reply', title: 'first', startedAt: 0 }),
      step(1, { kind: 'reply', title: 'second', startedAt: 500_000 }),
      step(2, { kind: 'reply', title: 'third', startedAt: 1_000_000 }),
    ];
    expect(swimClockHidden(swimLayout(roomy))).toEqual([false, false, false]);
  });

  it('an empty strip and a single step degrade without touching anything', () => {
    expect(swimClockHidden([])).toEqual([]);
    expect(swimClockHidden(swimLayout([step(0, { startedAt: 1 })]))).toEqual([false]);
  });
});

describe('the strip’s canvas grows with the lanes it actually opened', () => {
  it('a run that delegated nothing is exactly as tall as it always was', () => {
    const plain = [step(0, { kind: 'reply', startedAt: 0 }), step(1, { kind: 'tool', startedAt: 5 })];
    expect(swimLaneCount(plain)).toBe(0);
    expect(viewBoxFor('flight', 2, 0)).toEqual(viewBoxFor('flight', 2));
    expect(swimBox(2, 1)).toEqual(swimBox(2, 0));
    expect(swimClockY(1)).toBe(swimClockY(0));
  });

  it('each extra lane adds a row to both the canvas and the clock', () => {
    expect(swimBox(7, 2).height).toBeGreaterThan(swimBox(7, 1).height);
    expect(swimBox(7, 3).height).toBeGreaterThan(swimBox(7, 2).height);
    expect(swimBox(7, 3).width).toBe(swimBox(7, 1).width); // lanes are vertical
    expect(swimClockY(3)).toBeGreaterThan(swimClockY(1));
    expect(swimClockY(3)).toBeLessThan(swimBox(7, 3).height);
  });

  it('the lanes are NAMED, one tag per lane, and a single lane keeps its old name', () => {
    expect(swimLaneTags(1)).toEqual([{ label: 'DELEGATION', y: swimLaneTags(1)[0]!.y }]);
    const three = swimLaneTags(3);
    expect(three.map((t) => t.label)).toEqual(['SUB-AGENT 1', 'SUB-AGENT 2', 'SUB-AGENT 3']);
    expect(new Set(three.map((t) => t.y)).size).toBe(3);
    // ...and 0 lanes still names the row the strip draws, rather than nothing.
    expect(swimLaneTags(0)).toHaveLength(1);
  });

  it('layoutFor(flight) IS the swimlane layout — the map cannot get a second answer', () => {
    expect(layoutFor('flight', CONCURRENT).map((p) => [p.x, p.y]))
      .toEqual(swimLayout(CONCURRENT).map((p) => [p.x, p.y]));
  });
});

// THREAD IS SIGNED OFF. This golden was captured from the tree BEFORE the
// swimlane work landed (threadLayout + threadBranchPaths + viewBoxFor over a
// run carrying concurrency, nesting-free siblings, an open branch, a blocking
// branch, a tool, an error — and over an OLD-binary run with no clock at all).
// If a single coordinate or path string moves, thread moved, and thread must
// not move.
const THREAD_GOLDEN = '{"timed":{"points":[[260,36,0],[260,82,1],[150,128,2],[150,174,3],[150,450,4],[110,220,5],[110,496,6],[70,266,7],[370,312,8],[260,358,9],[260,404,10]],"rails":[{"first":2,"depart":"M 260 105 L 150 128","spine":"M 150 128 L 150 450","trail":null,"merge":"M 150 450 L 260 473","open":false,"background":true,"x":150,"endY":450},{"first":5,"depart":"M 260 197 L 110 220","spine":"M 110 220 L 110 496","trail":"M 110 496 L 110 519","merge":null,"open":true,"background":true,"x":110,"endY":519},{"first":7,"depart":"M 260 243 L 70 266","spine":null,"trail":null,"merge":"M 70 266 L 260 289","open":false,"background":false,"x":70,"endY":266}],"box":{"width":940,"height":566}},"old":{"points":[[260,36,0],[150,82,1],[150,128,2],[150,174,3],[260,220,4]],"rails":[{"first":1,"depart":"M 260 59 L 150 82","spine":"M 150 82 L 150 174","trail":null,"merge":"M 150 174 L 260 197","open":false,"x":150,"endY":174}],"box":{"width":940,"height":290}}}';

const GOLDEN_RUN: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'write three war stories while we talk', startedAt: 0 }),
  step(1, { kind: 'thinking', title: 'Thinking', startedAt: 100 }),
  step(2, { kind: 'subagent', tool: 'task', title: 'war story #1', background: true, status: 'completed', startedAt: 200, endedAt: 120_200 }),
  step(3, { kind: 'prompt', title: 'brief #1', depth: 1, parentOrdinal: 2, startedAt: 210 }),
  step(4, { kind: 'reply', title: 'story #1', depth: 1, parentOrdinal: 2, startedAt: 119_000 }),
  step(5, { kind: 'subagent', tool: 'task', title: 'war story #2', background: true, status: 'running', startedAt: 400 }),
  step(6, { kind: 'reply', title: 'partial #2', depth: 1, parentOrdinal: 5, startedAt: 150_000 }),
  step(7, { kind: 'subagent', tool: 'task', title: 'war story #3', background: false, status: 'completed', startedAt: 600, endedAt: 700 }),
  step(8, { kind: 'tool', tool: 'read', title: 'read notes.md', startedAt: 800 }),
  step(9, { kind: 'reply', title: 'Three agents writing now', startedAt: 1_000 }),
  step(10, { kind: 'error', title: 'ProviderAuthError', status: 'error', startedAt: 1_200 }),
];
const GOLDEN_OLD: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'audit the repo' }),
  step(1, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
  step(2, { kind: 'prompt', title: 'audit brief', depth: 1, parentOrdinal: 1 }),
  step(3, { kind: 'reply', title: 'audit findings', depth: 1, parentOrdinal: 1 }),
  step(4, { kind: 'reply', title: 'here is what it found' }),
];

describe('THREAD IS UNCHANGED — byte for byte against the pre-swimlane tree', () => {
  it('every marker, every rail segment and the canvas are identical', () => {
    const dump = (s: LayoutStep[]) => ({
      points: threadLayout(s).map((p) => [p.x, p.y, p.step.ordinal]),
      rails: threadBranchPaths(s),
      box: viewBoxFor('thread', s.length),
    });
    expect(JSON.stringify({ timed: dump(GOLDEN_RUN), old: dump(GOLDEN_OLD) })).toBe(THREAD_GOLDEN);
  });
});
