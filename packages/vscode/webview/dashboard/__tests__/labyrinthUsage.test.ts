// What a run SPENT. The failures worth catching here are arithmetic lies:
//  - one assistant message counted twice, so the run reads twice its real cost,
//  - a delegated stretch's spend charged to the thread that delegated it,
//  - a sum over a run with holes in it printed as though it were complete,
//  - a fabricated 0 standing in for a measurement nobody took.
// Every assertion is about the NUMBER a reader would believe.

import { describe, it, expect } from 'vitest';
import {
  usageBreakdown, stepUsageText, formatTokenCount, formatCost, type UsageStep,
} from '../components/labyrinthUsage';

const step = (ordinal: number, over: Partial<UsageStep> = {}): UsageStep => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, ...over,
} as UsageStep);
const tok = (input: number, output: number, extra: Record<string, unknown> = {}) => ({ input, output, ...extra });

/**
 * The real shape from the store: a `build` thread that spawns two `general`
 * sub-agents. The spawn steps carry the PARENT's usage (a `task` call is the
 * last part of the parent's message), which is exactly the attribution trap.
 */
const DELEGATED: UsageStep[] = [
  step(0, { kind: 'prompt', title: 'write two stories', agent: 'build' }),
  step(1, { kind: 'subagent', tool: 'task', title: 'story #1', agent: 'build', childSessionId: 'ses_k1', tokens: tok(1000, 10) }),
  step(2, { kind: 'reply', title: 'story #1 text', depth: 1, parentOrdinal: 1, agent: 'general', tokens: tok(27_920, 3744, { reasoning: 126 }) }),
  step(3, { kind: 'subagent', tool: 'task', title: 'story #2', agent: 'build', childSessionId: 'ses_k2', tokens: tok(2000, 20) }),
  step(4, { kind: 'reply', title: 'story #2 text', depth: 1, parentOrdinal: 3, agent: 'general', tokens: tok(27_149, 2972, { reasoning: 85 }) }),
  step(5, { kind: 'reply', title: 'both delivered', agent: 'build', tokens: tok(500, 5) }),
];

describe('labyrinthUsage — a branch total is that branch\'s own spend', () => {
  it('sums a delegated stretch\'s own steps and EXCLUDES the parent turn that spawned it', () => {
    const { branches, main } = usageBreakdown(DELEGATED);

    expect(branches.map((b) => b.title)).toEqual(['story #1', 'story #2']);
    // 27,920 + 3,744 + 126 — the sub-agent's own message, and only that.
    expect(branches[0]!.total.tokens).toBe(31_790);
    expect(branches[1]!.total.tokens).toBe(30_206);
    // The `task` call itself was made BY the trunk, so its 1,010 belongs there.
    // Charging it to the branch would inflate every delegated stretch by the
    // cost of the turn that asked for it.
    expect(branches[0]!.total.input).toBe(27_920);
    expect(main.tokens).toBe(1010 + 2020 + 505);
  });

  it('main + every branch is EXACTLY the run — no step counted twice, none dropped', () => {
    const { run, main, branches } = usageBreakdown(DELEGATED);
    const parts = main.tokens! + branches.reduce((n, b) => n + b.total.tokens!, 0);
    expect(parts).toBe(run.tokens);
    expect(run.counted).toBe(main.counted + branches.reduce((n, b) => n + b.total.counted, 0));
  });

  it('per-agent totals split the parent from the sub-agents', () => {
    const { agents, run } = usageBreakdown(DELEGATED);

    expect(agents.map((a) => a.agent)).toEqual(['general', 'build']);
    expect(agents.find((a) => a.agent === 'general')!.total.tokens).toBe(31_790 + 30_206);
    expect(agents.find((a) => a.agent === 'build')!.total.tokens).toBe(3535);
    // ...and the two together are the whole run, by a different route than the
    // branch split — two independent partitions that must agree.
    expect(agents.reduce((n, a) => n + a.total.tokens!, 0)).toBe(run.tokens);
  });

  it('a run that delegated nothing has no branches and a main total equal to the run', () => {
    const { run, main, branches } = usageBreakdown([
      step(0, { kind: 'prompt', title: 'hi', agent: 'build' }),
      step(1, { kind: 'reply', title: 'hello', agent: 'build', tokens: tok(12, 4) }),
    ]);
    expect(branches).toEqual([]);
    expect(main.tokens).toBe(16);
    expect(run.tokens).toBe(16);
  });
});

describe('labyrinthUsage — cache is not folded into input', () => {
  it('keeps reasoning and cache separate, and the headline matches the engine\'s own total', () => {
    // The real numbers off a cached turn in the v2-rebase store: 636 in against
    // 74,496 cache read. Folding them would hide the whole difference between
    // an expensive turn and a cheap one — and reporting only in/out would call
    // this 910 tokens when the engine's own `total` for it is 75,464.
    const { run } = usageBreakdown([
      step(0, { kind: 'reply', title: 'cached', agent: 'build', tokens: tok(636, 274, { reasoning: 58, cache: { read: 74_496, write: 0 } }) }),
    ]);
    expect(run.input).toBe(636);
    expect(run.cacheRead).toBe(74_496);
    expect(run.reasoning).toBe(58);
    expect(run.cacheWrite).toBe(0);
    expect(run.tokens).toBe(75_464);
  });

  it('OMITS a component no step recorded, rather than reporting it as zero', () => {
    const { run } = usageBreakdown([
      step(0, { kind: 'reply', title: 'plain', agent: 'build', tokens: tok(10, 20) }),
    ]);
    expect(run.reasoning).toBeUndefined();
    expect(run.cacheRead).toBeUndefined();
    expect(run.cacheWrite).toBeUndefined();
    expect(run.cost).toBeUndefined();
    expect(run.tokens).toBe(30);
  });

  it('KEEPS a genuine zero — a free local run is a measurement, not an absence', () => {
    const { run } = usageBreakdown([
      step(0, { kind: 'reply', title: 'local', agent: 'build', cost: 0, tokens: tok(0, 0, { reasoning: 0, cache: { read: 0, write: 0 } }) }),
    ]);
    expect(run.cost).toBe(0);
    expect(run.cacheRead).toBe(0);
    expect(run.tokens).toBe(0);
    expect(run.counted).toBe(1);
  });
});

describe('labyrinthUsage — a short total is never presented as a complete one', () => {
  it('flags the run APPROXIMATE when a message recorded no usage, and says how many', () => {
    const { run, caveats } = usageBreakdown([
      step(0, { kind: 'reply', title: 'counted', agent: 'build', tokens: tok(100, 10) }),
      step(1, { kind: 'reply', title: 'unrecorded', agent: 'build', usageMissing: true }),
    ]);
    expect(run.tokens).toBe(110);
    expect(run.missing).toBe(1);
    expect(run.approximate).toBe(true);
    expect(caveats.join(' ')).toContain('1 step recorded no usage');
  });

  it('attributes the gap to the RIGHT bucket — a hole in a branch is that branch\'s', () => {
    const holed = DELEGATED.map((s) => (s.ordinal === 4 ? { ...s, tokens: undefined, usageMissing: true as const } : s));
    const { branches, main, agents } = usageBreakdown(holed);

    expect(branches[1]!.total.approximate).toBe(true);
    expect(branches[0]!.total.approximate).toBe(false);
    expect(main.approximate).toBe(false);
    expect(agents.find((a) => a.agent === 'general')!.total.approximate).toBe(true);
    expect(agents.find((a) => a.agent === 'build')!.total.approximate).toBe(false);
  });

  it('a COMPLETE run is not flagged — the warning has to mean something', () => {
    const { run, caveats } = usageBreakdown(DELEGATED);
    expect(run.approximate).toBe(false);
    expect(caveats).toEqual([]);
  });

  it('a TRUNCATED run is approximate even when every loaded step reported usage', () => {
    const { run, caveats } = usageBreakdown(DELEGATED, { truncated: true });
    expect(run.approximate).toBe(true);
    expect(caveats.join(' ')).toContain('truncated');
  });

  it('a delegated run that was never EXPANDED is approximate — a whole sub-agent is missing', () => {
    // The spawn is here (it carries a childSessionId) but none of the child's
    // steps are: past MAX_CHILD_SESSIONS the engine returns the call and not
    // the run. Totalling that as complete drops the sub-agent's entire spend.
    const { run, caveats } = usageBreakdown([
      step(0, { kind: 'prompt', title: 'delegate', agent: 'build' }),
      step(1, { kind: 'subagent', tool: 'task', title: 'unexpanded', agent: 'build', childSessionId: 'ses_far', tokens: tok(50, 5) }),
      step(2, { kind: 'reply', title: 'done', agent: 'build', tokens: tok(10, 1) }),
    ]);
    expect(run.approximate).toBe(true);
    expect(caveats.join(' ')).toContain('1 delegated run was not expanded');
  });

  it('an EXPANDED delegation raises no such caveat', () => {
    expect(usageBreakdown(DELEGATED).caveats).toEqual([]);
  });
});

describe('labyrinthUsage — an old binary and an empty run', () => {
  it('steps carrying only {input,output} still total, with nothing invented around them', () => {
    const { run, main } = usageBreakdown([
      step(0, { kind: 'prompt', title: 'hi' }),
      step(1, { kind: 'reply', title: 'there', tokens: { input: 10, output: 20 } }),
    ]);
    expect(run.tokens).toBe(30);
    expect(run.reasoning).toBeUndefined();
    expect(run.missing).toBe(0);
    expect(run.approximate).toBe(false);
    // No `agent` on an old payload: the bucket is named, never dropped, so the
    // per-agent split still adds up to the run.
    expect(usageBreakdown([step(1, { kind: 'reply', title: 'x', tokens: { input: 1, output: 2 } })]).agents)
      .toEqual([{ agent: 'unknown', total: expect.objectContaining({ tokens: 3 }) }]);
    expect(main.tokens).toBe(30);
  });

  it('an empty run reports nothing at all — not a zero', () => {
    const { run, main, branches, agents, caveats } = usageBreakdown([]);
    expect(run.tokens).toBeUndefined();
    expect(run.counted).toBe(0);
    expect(run.approximate).toBe(false);
    expect(main.tokens).toBeUndefined();
    expect(branches).toEqual([]);
    expect(agents).toEqual([]);
    expect(caveats).toEqual([]);
  });

  it('a run where NO step recorded usage reports no total, not 0', () => {
    const { run } = usageBreakdown([step(0, { kind: 'prompt', title: 'hi' }), step(1, { kind: 'reply', title: 'yo' })]);
    expect(run.tokens).toBeUndefined();
    expect(run.input).toBeUndefined();
    expect(run.counted).toBe(0);
  });
});

describe('labyrinthUsage — the shapes that break an index-based attribution', () => {
  it('SIX sibling branches keep six separate totals, though only four columns exist', () => {
    // MAX_BRANCH_COLUMNS is 4, so the fifth and sixth branches FOLD onto the
    // outermost column. Attribution reads the open-branch stack, not the drawn
    // column, so folding must not merge two sub-agents' spend into one.
    const steps: UsageStep[] = [step(0, { kind: 'prompt', title: 'go', agent: 'build' })];
    for (let i = 0; i < 6; i++) {
      const spawn = steps.length;
      steps.push(step(spawn, { kind: 'subagent', tool: 'task', title: `kid ${i}`, agent: 'build', tokens: tok(1, 0) }));
      steps.push(step(spawn + 1, { kind: 'reply', title: `out ${i}`, depth: 1, parentOrdinal: spawn, agent: 'general', tokens: tok(100 + i, 0) }));
    }
    const { branches, main, run } = usageBreakdown(steps);

    expect(branches).toHaveLength(6);
    expect(branches.map((b) => b.total.tokens)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(main.tokens).toBe(6); // the six task calls, and nothing else
    expect(main.tokens! + branches.reduce((n, b) => n + b.total.tokens!, 0)).toBe(run.tokens);
  });

  it('a depth-1 step with NO parentOrdinal still bills to a branch, not to the trunk', () => {
    const { main, branches, run } = usageBreakdown([
      step(0, { kind: 'prompt', title: 'go', agent: 'build' }),
      step(1, { kind: 'reply', title: 'orphan', depth: 1, agent: 'general', tokens: tok(90, 0) }),
      step(2, { kind: 'reply', title: 'trunk', agent: 'build', tokens: tok(10, 0) }),
    ]);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.total.tokens).toBe(90);
    expect(main.tokens).toBe(10);
    expect(run.tokens).toBe(100);
  });

  it('a non-finite count is shown as nothing, never as "NaN"', () => {
    const { run } = usageBreakdown([
      step(0, { kind: 'reply', title: 'broken', agent: 'build', tokens: tok(Number.NaN, 5) }),
    ]);
    expect(formatTokenCount(run.tokens)).toBeUndefined();
    expect(stepUsageText(step(0, { kind: 'reply', title: 'x', cost: Number.POSITIVE_INFINITY }))).toBeUndefined();
  });
});

describe('labyrinthUsage — printing', () => {
  it('a step with no usage prints NOTHING, so the inspector renders no row', () => {
    expect(stepUsageText(step(0, { kind: 'reply', title: 'x' }))).toBeUndefined();
  });

  it('prints only the components the step actually has', () => {
    expect(stepUsageText(step(0, { kind: 'reply', title: 'x', tokens: { input: 10, output: 20 } })))
      .toBe('10 in · 20 out');
    expect(stepUsageText(step(0, {
      kind: 'reply', title: 'x', cost: 0,
      tokens: { input: 636, output: 274, reasoning: 58, cache: { read: 74_496, write: 0 } },
    }))).toBe('636 in · 274 out · 58 reasoning · 74,496 cache read · 0 cache write · $0');
  });

  it('formats counts readably and refuses to print a number it does not have', () => {
    expect(formatTokenCount(1234)).toBe('1,234');
    expect(formatTokenCount(75_464)).toBe('75.5k');
    expect(formatTokenCount(1_250_000)).toBe('1.25M');
    expect(formatTokenCount(undefined)).toBeUndefined();
    expect(formatTokenCount(Number.NaN)).toBeUndefined();
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(undefined)).toBeUndefined();
  });
});
