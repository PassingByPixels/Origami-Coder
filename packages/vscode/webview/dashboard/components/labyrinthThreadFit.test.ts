// Pure-geometry tests for labyrinthThreadFit.ts. The defect these exist for is
// invisible to every DOM test in this suite: jsdom has no layout engine, so a
// label running across the neighbouring branch column produces no measurable
// overlap and no computed style to read. It is only catchable as arithmetic.
//
// The numbers below are the two real pitches: LANE_GAP (110), the spine's
// nearest neighbour, and BRANCH_COL_GAP (40), which is what a run with two or
// more concurrent sub-agents actually draws at.
import { describe, expect, it } from 'vitest';
import { branchColumns, columnPitch, metaFits, threshHalf, glyphSize, captionChars } from './labyrinthThreadFit';
import { THREAD_SPINE_X, LANE_GAP } from './labyrinthLayout';
import { BRANCH_COL_GAP, branchX } from './labyrinthRails';

const step = (ordinal: number, over: Record<string, unknown> = {}) => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, ...over,
});
/** Two sub-agents that are still running together — the shape the user saw. */
const CONCURRENT = [
  step(0, { kind: 'prompt', title: 'do both', startedAt: 1_000 }),
  step(1, { kind: 'subagent', tool: 'task', title: 'first', background: true, startedAt: 1_100, endedAt: 9_000 }),
  step(2, { kind: 'subagent', tool: 'task', title: 'second', background: true, startedAt: 1_200, endedAt: 9_500 }),
  step(3, { kind: 'reply', title: 'both away', startedAt: 1_300 }),
];

describe('branchColumns — one branch crowds nothing', () => {
  it('is 0 with no delegation at all', () => {
    expect(branchColumns([step(0, { kind: 'prompt' }), step(1)])).toBe(0);
  });

  it('is 1 for a single sub-agent, and 2 once two run concurrently', () => {
    expect(branchColumns(CONCURRENT.slice(0, 2))).toBe(1);
    expect(branchColumns(CONCURRENT)).toBe(2);
  });
});

describe('columnPitch — the budget comes from the pitch AT THE POINT', () => {
  it('the spine and the two lanes are a whole LANE_GAP from their neighbour', () => {
    expect(columnPitch(THREAD_SPINE_X, THREAD_SPINE_X, 3)).toBe(LANE_GAP);
    expect(columnPitch(THREAD_SPINE_X + LANE_GAP, THREAD_SPINE_X, 3)).toBe(LANE_GAP);
  });

  it('a LONE branch column keeps the spine budget — its only neighbour IS the spine', () => {
    expect(columnPitch(branchX(THREAD_SPINE_X, 0), THREAD_SPINE_X, 1)).toBe(LANE_GAP);
  });

  it('every branch column is BRANCH_COL_GAP apart once a second one is in use', () => {
    expect(columnPitch(branchX(THREAD_SPINE_X, 0), THREAD_SPINE_X, 2)).toBe(BRANCH_COL_GAP);
    expect(columnPitch(branchX(THREAD_SPINE_X, 1), THREAD_SPINE_X, 2)).toBe(BRANCH_COL_GAP);
    expect(columnPitch(branchX(THREAD_SPINE_X, 4), THREAD_SPINE_X, 5)).toBe(BRANCH_COL_GAP);
  });
});

describe('the furniture budget at each pitch', () => {
  it('at a branch pitch the meta text does NOT fit beside the marker; at the spine it does', () => {
    expect(metaFits(BRANCH_COL_GAP)).toBe(false);
    expect(metaFits(LANE_GAP)).toBe(true);
  });

  it('the threshold bar never spans more than its own column', () => {
    expect(threshHalf(BRANCH_COL_GAP)).toBe(18);
    expect(threshHalf(LANE_GAP)).toBe(26);
    // The bar is drawn +/- this, so twice it must stay inside the pitch —
    // 52 wide against a 40 pitch was the overlap this replaced.
    expect(threshHalf(BRANCH_COL_GAP) * 2).toBeLessThan(BRANCH_COL_GAP);
  });

  it('the glyph is squeezed at a branch pitch and full size at the spine', () => {
    // 40 - the neighbour's own 18-unit threshold bar - the 12-unit offset.
    expect(glyphSize(BRANCH_COL_GAP)).toBe(10);
    expect(glyphSize(LANE_GAP)).toBe(18);
    // It must still clear that bar, which is what it collided with.
    expect(12 + glyphSize(BRANCH_COL_GAP)).toBeLessThanOrEqual(BRANCH_COL_GAP - threshHalf(BRANCH_COL_GAP));
  });

  it('every rule loosens monotonically — a wider column never prints LESS', () => {
    expect(metaFits(200)).toBe(true);
    expect(glyphSize(200)).toBe(18);
    expect(threshHalf(200)).toBe(26); // capped at the spine's own half-width
  });
});

describe('captionChars — the prefix is paid for out of the label budget', () => {
  it('the prefix and its separator both come out of the maximum', () => {
    expect(captionChars(50, '12 · 4.2s')).toBe(50 - 9 - 3);
  });

  it('a label still gets a readable floor when the prefix is absurdly long', () => {
    expect(captionChars(50, 'x'.repeat(80))).toBe(8);
  });
});
