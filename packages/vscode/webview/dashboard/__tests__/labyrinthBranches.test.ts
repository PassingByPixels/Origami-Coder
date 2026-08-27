// The BRANCH model — the defect this whole round exists for.
//
// The regression: lane was decided by KIND, and a sub-agent's own steps come
// back as ordinary `prompt`/`thinking`/`reply` carrying `depth: 1`. So the
// `subagent` marker jutted off the trunk correctly and then the three steps it
// delegated sat back ON the trunk, reading as work the MAIN agent did. Every
// test here asserts the REQUIREMENT (which thread is this step on, does the
// branch leave and come back, is a column recycled) rather than the pixel
// arithmetic, so the constants can move without rewriting them.

import { describe, it, expect } from 'vitest';
import {
  branchModel, branchX, MAX_BRANCH_COLUMNS,
  threadLayout, threadBranchPaths, viewBoxFor, laneFor,
  THREAD_SPINE_X, type LayoutStep,
} from '../components/labyrinthLayout';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal,
  kind: 'reply',
  title: `step ${ordinal}`,
  ...over,
});

/** The shape `run_steps` actually returns: a child's steps INLINE after their
 *  spawn, carrying depth + parentOrdinal (engine run-steps.ts `collect`). */
const DELEGATED: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'audit the repo' }),
  step(1, { kind: 'thinking', title: 'Thinking' }),
  step(2, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
  step(3, { kind: 'prompt', title: 'audit brief', depth: 1, parentOrdinal: 2 }),
  step(4, { kind: 'thinking', title: 'Thinking', depth: 1, parentOrdinal: 2 }),
  step(5, { kind: 'reply', title: 'audit findings', depth: 1, parentOrdinal: 2 }),
  step(6, { kind: 'reply', title: 'here is what it found' }),
];

const xs = (steps: LayoutStep[]) => threadLayout(steps).map((p) => p.x);

describe('a sub-agent’s OWN steps leave the trunk — the round-2 regression', () => {
  it('a depth-1 prompt/thinking/reply sits OFF the spine, on its parent’s branch column', () => {
    const { column } = branchModel(DELEGATED);
    const x = xs(DELEGATED);

    // The three delegated steps are not on the trunk...
    for (const i of [3, 4, 5]) {
      expect(column[i], `step ${i} fell back onto the trunk`).toBeGreaterThanOrEqual(0);
      expect(x[i]).not.toBe(THREAD_SPINE_X);
    }
    // ...they are on the SAME column, and it is the spawn's own column.
    expect(new Set([column[2], column[3], column[4], column[5]]).size).toBe(1);
    expect(new Set([x[2], x[3], x[4], x[5]]).size).toBe(1);
    // ...and the main agent's steps really are still on it.
    for (const i of [0, 1, 6]) {
      expect(column[i]).toBe(-1);
      expect(x[i]).toBe(THREAD_SPINE_X);
    }
  });

  it('depth outranks kind: a delegated TOOL joins the branch instead of jutting the tool way', () => {
    const steps = [
      step(0, { kind: 'tool', tool: 'read', title: 'read agent.ts' }),
      step(1, { kind: 'subagent', tool: 'task', title: 'delegate' }),
      step(2, { kind: 'tool', tool: 'read', title: 'read deep.ts', depth: 1, parentOrdinal: 1 }),
    ];
    const x = xs(steps);
    expect(laneFor(steps[0]!)).toBe('tools');
    expect(laneFor(steps[2]!)).toBe('delegation');
    expect(x[0]).toBeGreaterThan(THREAD_SPINE_X); // an OWN tool still juts right
    expect(x[2]).toBeLessThan(THREAD_SPINE_X);    // a DELEGATED tool is on the branch
    expect(x[2]).toBe(x[1]);
  });

  it('the run still reads straight down — a branch moves x, never y', () => {
    const pts = threadLayout(DELEGATED);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.y).toBeGreaterThan(pts[i - 1]!.y);
  });
});

describe('a branch DEPARTS the trunk and MERGES back', () => {
  it('draws both ends, and its own vertical run in between', () => {
    const paths = threadBranchPaths(DELEGATED);
    expect(paths).toHaveLength(1);
    const [b] = paths as [(typeof paths)[0]];
    const pts = threadLayout(DELEGATED);
    const col = pts[2]!.x;

    // Departure: starts on the TRUNK, ends on the branch column.
    const depart = b.depart.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!;
    expect(Number(depart[1])).toBe(THREAD_SPINE_X);
    expect(Number(depart[3])).toBe(col);
    // Merge: the mirror — starts on the column, RETURNS to the trunk, and does
    // so BELOW the branch's last step. A branch that never rejoins reads as an
    // abandoned thread, which is the thing this half exists to prevent.
    const merge = b.merge.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!;
    expect(Number(merge[1])).toBe(col);
    expect(Number(merge[3])).toBe(THREAD_SPINE_X);
    expect(Number(merge[2])).toBe(pts[5]!.y);
    expect(Number(merge[4])).toBeGreaterThan(pts[5]!.y);
    // And the segment spans the whole delegated stretch.
    const spine = b.spine!.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!;
    expect(Number(spine[2])).toBe(pts[2]!.y);
    expect(Number(spine[4])).toBe(pts[5]!.y);
  });

  it('a sub-agent whose steps were NOT expanded still departs and merges (a one-step branch)', () => {
    const paths = threadBranchPaths([
      step(0, { kind: 'prompt' }),
      step(1, { kind: 'subagent', tool: 'task', title: 'unexpanded' }),
      step(2, { kind: 'reply' }),
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.depart).toBeTruthy();
    expect(paths[0]!.merge).toBeTruthy();
    // Nothing to run THROUGH, so no invented segment.
    expect(paths[0]!.spine).toBeNull();
  });

  it('every branch in a run gets its own rail — none is silently dropped', () => {
    const steps = [
      step(0, { kind: 'subagent', tool: 'task' }),
      step(1, { kind: 'reply', depth: 1, parentOrdinal: 0 }),
      step(2, { kind: 'subagent', tool: 'task' }),
      step(3, { kind: 'reply', depth: 1, parentOrdinal: 2 }),
    ];
    expect(threadBranchPaths(steps)).toHaveLength(2);
    expect(new Set(threadBranchPaths(steps).map((p) => p.first)).size).toBe(2);
  });
});

describe('branch COLUMNS are allocated per open branch and released on merge', () => {
  // Nesting is the only way two branches are open at once, because run_steps
  // inlines a child's steps after its parent — siblings never interleave.
  const NESTED: LayoutStep[] = [
    step(0, { kind: 'prompt' }),
    step(1, { kind: 'subagent', tool: 'task', title: 'outer' }),
    step(2, { kind: 'prompt', depth: 1, parentOrdinal: 1 }),
    step(3, { kind: 'subagent', tool: 'task', title: 'inner', depth: 1, parentOrdinal: 1 }),
    step(4, { kind: 'reply', depth: 2, parentOrdinal: 3 }),
    step(5, { kind: 'reply', depth: 1, parentOrdinal: 1 }),
    step(6, { kind: 'subagent', tool: 'task', title: 'inner two', depth: 1, parentOrdinal: 1 }),
    step(7, { kind: 'reply', depth: 2, parentOrdinal: 6 }),
    step(8, { kind: 'reply' }),
  ];

  it('two sub-agents open AT ONCE never share a column', () => {
    const { column } = branchModel(NESTED);
    expect(column[1]).not.toBe(column[3]); // outer vs inner, both open
    expect(column[4]).toBe(column[3]);     // the inner's child is on the inner
    expect(column[2]).toBe(column[1]);     // the outer's own child on the outer
    expect(xs(NESTED)[3]).not.toBe(xs(NESTED)[1]);
  });

  it('a column is REUSED once the branch holding it has merged', () => {
    const { column } = branchModel(NESTED);
    // `inner` merged at step 5, so `inner two` takes its column back.
    expect(column[6]).toBe(column[3]);
    expect(column[7]).toBe(column[3]);
    // Only ever two columns in play across the whole run.
    const live = column.filter((c) => c >= 0);
    expect(new Set(live).size).toBe(2);
  });

  it('25 SEQUENTIAL sub-agents produce ONE column, not 25', () => {
    const steps: LayoutStep[] = [];
    for (let i = 0; i < 25; i++) {
      steps.push(step(steps.length, { kind: 'subagent', tool: 'task' }));
      steps.push(step(steps.length, { kind: 'reply', depth: 1, parentOrdinal: steps.length - 1 }));
    }
    const { column, spans } = branchModel(steps);
    expect(spans).toHaveLength(25);
    expect(new Set(column.filter((c) => c >= 0))).toEqual(new Set([0]));
  });

  it('a deeper nest than we have columns FOLDS onto the outermost instead of walking off the canvas', () => {
    // Nine nested spawns against MAX_BRANCH_COLUMNS columns.
    const steps: LayoutStep[] = [];
    for (let d = 0; d < 9; d++) {
      steps.push(
        step(steps.length, d === 0
          ? { kind: 'subagent', tool: 'task' }
          : { kind: 'subagent', tool: 'task', depth: d, parentOrdinal: steps.length - 1 }),
      );
    }
    const { column } = branchModel(steps);
    for (const c of column) expect(c).toBeLessThan(MAX_BRANCH_COLUMNS);
    // Folding is real: some outer pair genuinely shares the last column.
    expect(new Set(column).size).toBeLessThanOrEqual(MAX_BRANCH_COLUMNS);
    const box = viewBoxFor('thread', steps.length);
    for (const p of threadLayout(steps)) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(box.width);
    }
  });
});

describe('the model survives what the engine may actually omit', () => {
  it('depth WITHOUT parentOrdinal still lands off the spine', () => {
    const steps = [
      step(0, { kind: 'prompt' }),
      step(1, { kind: 'reply', depth: 1 }),
      step(2, { kind: 'thinking', depth: 1 }),
      step(3, { kind: 'reply' }),
    ];
    const { column } = branchModel(steps);
    const x = xs(steps);
    expect(column[1]).toBeGreaterThanOrEqual(0);
    expect(column[2]).toBe(column[1]); // one unnamed branch, not two
    expect(x[1]).toBeLessThan(THREAD_SPINE_X);
    expect(x[3]).toBe(THREAD_SPINE_X);
    expect(threadBranchPaths(steps)).toHaveLength(1);
  });

  it('a changed parentOrdinal at the same depth ENDS the previous branch', () => {
    const steps = [
      step(0, { kind: 'reply', depth: 1, parentOrdinal: 90 }),
      step(1, { kind: 'reply', depth: 1, parentOrdinal: 91 }),
    ];
    const { spans } = branchModel(steps);
    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.key)).toEqual([90, 91]);
  });

  it('a run with no delegation at all has no branches and no rails', () => {
    const plain = [step(0, { kind: 'prompt' }), step(1, { kind: 'tool', tool: 'read' }), step(2, { kind: 'reply' })];
    expect(branchModel(plain).spans).toEqual([]);
    expect(threadBranchPaths(plain)).toEqual([]);
    expect(branchModel([]).spans).toEqual([]);
    expect(threadBranchPaths([])).toEqual([]);
  });

  it('a junk depth degrades to the trunk rather than opening a phantom branch', () => {
    for (const depth of [Number.NaN, Number.POSITIVE_INFINITY, -3, 0]) {
      const { column, spans } = branchModel([step(0, { kind: 'reply', depth })]);
      expect(column[0]).toBe(-1);
      expect(spans).toEqual([]);
    }
  });

  it('branchX stacks columns OUTWARD on the delegation side, never across the spine', () => {
    let prev = THREAD_SPINE_X;
    for (let c = 0; c < MAX_BRANCH_COLUMNS; c++) {
      const x = branchX(THREAD_SPINE_X, c);
      expect(x).toBeLessThan(prev);
      expect(x).toBeGreaterThan(0);
      prev = x;
    }
  });
});
