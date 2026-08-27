// A branch as a true SPAN — the defect this round exists for.
//
// The regression: `run_steps` expands a child's steps inline immediately after
// its spawn, so a branch was drawn as closing at its own last step. That was
// accurate while sub-agents BLOCKED. They now detach by default: the parent's
// turn ends, the user keeps talking, and the child reports back minutes later.
// Drawing that as "finished the instant it was spawned" is a lie about the run.
//
// Every test here asserts the REQUIREMENT — does the merge land after the work
// that genuinely ran alongside it, does a run that never came back stay open,
// does a build that sends none of the new fields draw exactly what it drew
// before — rather than pixel arithmetic, so the constants can still move.

import { describe, it, expect } from 'vitest';
import {
  branchModel, threadLayout, threadBranchPaths, flightLayout, flightSpans, flightIsTimeBased,
  spanIsOpen, spanBackground, mergeIndex, isThreshold, viewBoxFor, type LayoutStep,
} from '../components/labyrinthLayout';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal,
  kind: 'reply',
  title: `step ${ordinal}`,
  ...over,
});

/**
 * The shape of the real exported run this round was built from
 * (origami-session-Tsuru-2026-07-29): tasks backgrounded up front, ordinary
 * main-thread work while they ran, results landing later. Story #1 ends at
 * 5_000 — AFTER the capitals exchange started and BEFORE the next prompt — so
 * exactly which steps ran alongside it is a fact with one right answer.
 */
const CONCURRENT: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'write three stories while we talk', startedAt: 1_000 }),
  step(1, {
    kind: 'subagent', tool: 'task', title: 'Write war story #1',
    background: true, status: 'completed', childSessionId: 'ses_child1',
    startedAt: 1_100, endedAt: 5_000, durationMs: 3_900,
  }),
  step(2, { kind: 'reply', title: 'three sub-agents writing now', startedAt: 1_200 }),
  step(3, { kind: 'prompt', title: 'now list the capitals of europe', startedAt: 2_000 }),
  step(4, { kind: 'reply', title: 'Albania — Tirana …', startedAt: 2_500 }),
  step(5, { kind: 'prompt', title: 'are the subagents done', startedAt: 9_000 }),
  step(6, { kind: 'reply', title: 'story #1 landed', startedAt: 9_500 }),
];

/** The same run with every new field stripped — what an OLDER engine sends. */
const stripped = (steps: LayoutStep[]): LayoutStep[] =>
  steps.map(({ background, status, startedAt, endedAt, durationMs, childSessionId, ...rest }) => rest);

const rail = (steps: LayoutStep[], i = 0) => threadBranchPaths(steps)[i]!;
const yOf = (steps: LayoutStep[], i: number) => threadLayout(steps)[i]!.y;
/** The y a rail's merge segment LEAVES the branch column at. */
const mergeY = (path: string) => Number(path.match(/M [\d.-]+ ([\d.-]+)/)![1]);

describe('a background branch merges where it ACTUALLY returned', () => {
  it('main-thread steps that ran during it are ALONGSIDE the branch, not after it', () => {
    const b = rail(CONCURRENT);

    // Steps 2-4 started before story #1 ended, so the branch is still open
    // across them: it merges at step 4's row, not at its own spawn row.
    expect(b.merge).not.toBeNull();
    expect(mergeY(b.merge!)).toBe(yOf(CONCURRENT, 4));
    for (const i of [2, 3, 4]) {
      expect(mergeY(b.merge!), `step ${i} was drawn after the branch, not beside it`)
        .toBeGreaterThanOrEqual(yOf(CONCURRENT, i));
    }
    // ...and step 5 started AFTER it ended, so it is genuinely past the merge.
    expect(mergeY(b.merge!)).toBeLessThan(yOf(CONCURRENT, 5));
    // Those steps stay on the TRUNK — alongside means beside, not absorbed.
    expect(branchModel(CONCURRENT).column.slice(2, 5)).toEqual([-1, -1, -1]);
  });

  it('the in-flight stretch is drawn: rail past its own last step, down to the merge', () => {
    const b = rail(CONCURRENT);
    expect(b.trail).not.toBeNull();
    const [, y1, , y2] = b.trail!.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!.slice(1).map(Number);
    expect(y1).toBe(yOf(CONCURRENT, 1)); // its own (only) step
    expect(y2).toBe(yOf(CONCURRENT, 4)); // where it actually came back
  });

  it('THE CONTRAST: strip the clock and the very same run merges at the spawn again', () => {
    const bare = stripped(CONCURRENT);
    const b = rail(bare);
    expect(mergeY(b.merge!)).toBe(yOf(bare, 1));
    expect(b.trail).toBeNull(); // no span it can support, so none is drawn
  });

  it('a BLOCKING sub-agent still merges immediately — the clock, not the flag, decides', () => {
    // No `background` at all, and an end before the next step starts: the same
    // rule must place this one straight after its own step.
    const blocking: LayoutStep[] = [
      step(0, { kind: 'prompt', startedAt: 1_000 }),
      step(1, { kind: 'subagent', tool: 'task', status: 'completed', startedAt: 1_100, endedAt: 1_400 }),
      step(2, { kind: 'reply', startedAt: 2_000 }),
    ];
    expect(mergeY(rail(blocking).merge!)).toBe(yOf(blocking, 1));
    expect(rail(blocking).trail).toBeNull();
  });

  it('the walk STOPS at a step it cannot place in time — a clock gap is not evidence', () => {
    const gappy: LayoutStep[] = [
      step(0, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 10, endedAt: 9_000 }),
      step(1, { kind: 'reply', startedAt: 100 }),
      step(2, { kind: 'reply' }), // no clock: unplaceable
      step(3, { kind: 'reply', startedAt: 200 }), // would have qualified
    ];
    // Merges at 1, NOT at 3 — stepping over the timeless step to reach a later
    // timestamp would claim a span the run never proved.
    expect(mergeIndex(gappy, 0, 0)).toBe(1);
    expect(mergeY(rail(gappy).merge!)).toBe(yOf(gappy, 1));
  });
});

describe('a sub-agent that never came back stays OPEN', () => {
  const RUNNING: LayoutStep[] = [
    step(0, { kind: 'prompt', startedAt: 1_000 }),
    step(1, { kind: 'subagent', tool: 'task', title: 'Write war story #2', background: true, status: 'running', startedAt: 1_100 }),
    step(2, { kind: 'reply', title: 'still going', startedAt: 2_000 }),
  ];

  it('departs and NEVER merges — no merge segment is drawn at all', () => {
    const b = rail(RUNNING);
    expect(b.open).toBe(true);
    expect(b.depart).toBeTruthy();
    expect(b.merge).toBeNull();
    // The rail still runs on past its own step, so it reads as unfinished
    // rather than as a branch that simply stopped.
    expect(b.trail).not.toBeNull();
    expect(b.endY).toBeGreaterThan(yOf(RUNNING, 1));
  });

  it('a background spawn with NO endedAt is open too, however its status reads', () => {
    expect(spanIsOpen({ kind: 'subagent', background: true })).toBe(true);
    expect(spanIsOpen({ kind: 'subagent', background: true, status: 'pending' })).toBe(true);
    // ...but a SETTLED status outranks the missing clock: finished, not in flight.
    expect(spanIsOpen({ kind: 'subagent', background: true, status: 'completed' })).toBe(false);
    expect(spanIsOpen({ kind: 'subagent', background: true, status: 'error' })).toBe(false);
    // ...and nothing else in the run is ever "open".
    expect(spanIsOpen({ kind: 'tool', status: 'running' })).toBe(false);
    expect(spanIsOpen(undefined)).toBe(false);
  });

  it('an open branch is distinguishable from a completed one on the SAME run', () => {
    const mixed: LayoutStep[] = [
      step(0, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 10, endedAt: 20 }),
      step(1, { kind: 'reply', startedAt: 30 }),
      step(2, { kind: 'subagent', tool: 'task', background: true, status: 'running', startedAt: 40 }),
      step(3, { kind: 'reply', startedAt: 50 }),
    ];
    const rails = threadBranchPaths(mixed);
    expect(rails.map((b) => b.open)).toEqual([false, true]);
    expect(rails.map((b) => b.merge === null)).toEqual([false, true]);
  });
});

describe('foreground vs background vs "the engine did not say"', () => {
  const spawn = (over: Partial<LayoutStep>) =>
    rail([step(0, { kind: 'prompt' }), step(1, { kind: 'subagent', tool: 'task', ...over }), step(2)]);

  it('carries the flag through when it was sent, either way', () => {
    expect(spawn({ background: true }).background).toBe(true);
    expect(spawn({ background: false }).background).toBe(false);
  });

  it('says NOTHING when it was absent — the key is missing, not undefined or false', () => {
    const b = spawn({});
    expect('background' in b).toBe(false);
    expect(spanBackground({ kind: 'subagent' })).toBeUndefined();
    // The engine only ever emits `true`, so absent covers BOTH an older binary
    // and a foreground spawn. Reading it as foreground would invent a fact.
    expect(spanBackground({ kind: 'reply', background: true })).toBeUndefined();
  });
});

describe('branches that overlap in TIME never share a column', () => {
  it('three tasks backgrounded together get three rails, drawn in parallel', () => {
    const trio: LayoutStep[] = [
      step(0, { kind: 'prompt', startedAt: 1_000 }),
      step(1, { kind: 'subagent', tool: 'task', title: '#1', background: true, status: 'completed', startedAt: 1_100, endedAt: 8_000 }),
      step(2, { kind: 'subagent', tool: 'task', title: '#2', background: true, status: 'completed', startedAt: 1_200, endedAt: 8_100 }),
      step(3, { kind: 'subagent', tool: 'task', title: '#3', background: true, status: 'running', startedAt: 1_300 }),
      step(4, { kind: 'reply', title: 'they will deliver when ready', startedAt: 1_400 }),
      step(5, { kind: 'prompt', title: 'capitals of europe', startedAt: 2_000 }),
      step(6, { kind: 'reply', title: 'Tirana …', startedAt: 2_500 }),
    ];
    const rails = threadBranchPaths(trio);
    expect(rails).toHaveLength(3);
    const cols = rails.map((b) => b.x);
    expect(new Set(cols).size, 'two rails drawn down the same column would overlap').toBe(3);
    // All three are still running at the capitals exchange, so all three rails
    // reach past it: that is the trunk-with-branches-alongside shape.
    for (const b of rails) expect(b.endY).toBeGreaterThanOrEqual(yOf(trio, 6));
  });

  it('SEQUENTIAL background tasks still recycle one column — no needless fanout', () => {
    const seq: LayoutStep[] = [
      step(0, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 10, endedAt: 20 }),
      step(1, { kind: 'reply', startedAt: 30 }),
      step(2, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 40, endedAt: 50 }),
      step(3, { kind: 'reply', startedAt: 60 }),
    ];
    expect(new Set(threadBranchPaths(seq).map((b) => b.x)).size).toBe(1);
  });
});

describe('an OLDER engine binary — none of the new fields at all', () => {
  // The regression that will actually happen: the extension ships ahead of the
  // engine, every optional field arrives absent, and the map must be unchanged.
  const OLD: LayoutStep[] = [
    step(0, { kind: 'prompt', title: 'audit the repo' }),
    step(1, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
    step(2, { kind: 'prompt', title: 'audit brief', depth: 1, parentOrdinal: 1 }),
    step(3, { kind: 'reply', title: 'audit findings', depth: 1, parentOrdinal: 1 }),
    step(4, { kind: 'reply', title: 'here is what it found' }),
  ];

  it('draws exactly what it drew before: depart, spine, merge at its own last step', () => {
    const b = rail(OLD);
    expect(b.merge).not.toBeNull();
    expect(mergeY(b.merge!)).toBe(yOf(OLD, 3)); // the branch's own last step
    expect(b.spine).not.toBeNull();
    expect(b.endY).toBe(yOf(OLD, 3));
    expect(b.open).toBe(false);
    expect(b.trail).toBeNull();          // nothing in flight was invented
    expect('background' in b).toBe(false); // and nothing was claimed about mode
  });

  it('is byte-identical to the same run with the new fields explicitly undefined', () => {
    const undef = OLD.map((s) => ({ ...s, background: undefined, endedAt: undefined, status: undefined }));
    expect(threadBranchPaths(undef)).toEqual(threadBranchPaths(OLD));
  });

  it('every span in an untimed run still merges — none is left hanging open', () => {
    for (const b of threadBranchPaths(OLD)) {
      expect(b.open).toBe(false);
      expect(b.merge).not.toBeNull();
    }
    expect(branchModel(OLD).spans.every((s) => s.mergeAt === s.last)).toBe(true);
  });
});

describe('a span that runs off the end of what we can see', () => {
  it('an open branch stays INSIDE the viewBox — it cannot trail off the canvas', () => {
    for (const n of [1, 2, 7]) {
      const steps: LayoutStep[] = [
        step(0, { kind: 'subagent', tool: 'task', background: true, status: 'running', startedAt: 10 }),
        ...Array.from({ length: n - 1 }, (_, i) => step(i + 1, { kind: 'reply', startedAt: 20 + i })),
      ];
      const box = viewBoxFor('thread', steps.length);
      for (const b of threadBranchPaths(steps)) {
        expect(b.endY, `n=${n}`).toBeLessThan(box.height);
        expect(b.x).toBeGreaterThan(0);
      }
    }
  });

  it('a run TRUNCATED before the sub-agent returned merges at the last visible step, not past it', () => {
    // endedAt is far beyond anything in the window: the branch must stop at the
    // edge of what we were sent rather than pointing at a row that is not there.
    const cut: LayoutStep[] = [
      step(0, { kind: 'subagent', tool: 'task', background: true, status: 'completed', startedAt: 10, endedAt: 9_000_000 }),
      step(1, { kind: 'reply', startedAt: 20 }),
      step(2, { kind: 'reply', startedAt: 30 }),
    ];
    const b = rail(cut);
    expect(b.endY).toBe(yOf(cut, 2));
    expect(b.endY).toBeLessThan(viewBoxFor('thread', cut.length).height);
  });

  it('the thresholds filter reindexes the list — spans survive it without inventing one', () => {
    // The pane filters to failures only, so a spawn can lose its own children
    // and its neighbours change underneath it. Nothing may crash, and no branch
    // may claim a span across steps that are no longer on screen.
    const mixed: LayoutStep[] = [
      step(0, { kind: 'prompt', startedAt: 10 }),
      step(1, { kind: 'subagent', tool: 'task', background: true, status: 'error', startedAt: 20, endedAt: 9_000, error: 'child failed' }),
      step(2, { kind: 'reply', depth: 1, parentOrdinal: 1, startedAt: 30 }),
      step(3, { kind: 'error', title: 'ProviderAuthError', status: 'error', startedAt: 40 }),
    ];
    const onlyFailures = mixed.filter(isThreshold);
    expect(onlyFailures).toHaveLength(2);
    const paths = threadBranchPaths(onlyFailures);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.open).toBe(false); // it errored, it did not vanish
    expect(paths[0]!.endY).toBeLessThan(viewBoxFor('thread', onlyFailures.length).height);
  });
});

describe('flight — the view where overlap is honest', () => {
  it('becomes TIME-BASED once the sub-agent steps carry timestamps', () => {
    expect(flightIsTimeBased(CONCURRENT)).toBe(true);
    // One timeless sub-agent step is still enough to collapse it, which is the
    // pre-existing honesty gate: mixing real positions with invented ones is
    // worse than admitting there is no timing.
    const oneTimeless = CONCURRENT.map((s, i) => (i === 1 ? { ...s, startedAt: undefined } : s));
    expect(flightIsTimeBased(oneTimeless)).toBe(false);
    expect(flightIsTimeBased(stripped(CONCURRENT))).toBe(false);
  });

  it('a background sub-agent gets a duration BAR that overlaps the steps it ran through', () => {
    const [bar] = flightSpans(CONCURRENT);
    const pts = flightLayout(CONCURRENT);
    expect(bar).toBeDefined();
    expect(bar!.index).toBe(1);
    expect(bar!.background).toBe(true);
    expect(bar!.open).toBe(false);
    // Steps 2-4 ran while it was working, so their markers fall INSIDE the bar
    // — the overlap this view exists to show, and the one place it is honest.
    for (const i of [2, 3, 4]) {
      expect(pts[i]!.x, `step ${i} should sit within the sub-agent's bar`).toBeGreaterThan(bar!.x1);
      expect(pts[i]!.x).toBeLessThanOrEqual(bar!.x2);
    }
    // Step 5 started after it returned, so it is genuinely past the bar's end.
    expect(pts[5]!.x).toBeGreaterThan(bar!.x2);
  });

  it('draws NO bars when the strip cannot use time — a length would be invention', () => {
    expect(flightSpans(stripped(CONCURRENT))).toEqual([]);
  });

  it('a still-running sub-agent runs to the axis end and is flagged open, not given a false finish', () => {
    const running = CONCURRENT.map((s, i) => (i === 1 ? { ...s, status: 'running' as const, endedAt: undefined, durationMs: undefined } : s));
    const [bar] = flightSpans(running);
    expect(bar!.open).toBe(true);
    expect(bar!.x2).toBeGreaterThan(bar!.x1);
  });

  it('a step with no end and no open flag gets no bar rather than a zero-length one', () => {
    const noEnd: LayoutStep[] = [
      step(0, { kind: 'prompt', startedAt: 1_000 }),
      step(1, { kind: 'subagent', tool: 'task', status: 'completed', startedAt: 1_100 }),
      step(2, { kind: 'reply', startedAt: 2_000 }),
    ];
    expect(flightSpans(noEnd)).toEqual([]);
  });
});
