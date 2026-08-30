// The nesting rules, as assertions rather than as a rendered strip.
//
// Two things are worth getting right here and neither is visible in a
// screenshot: what a depth the model got WRONG turns into, and how many
// children a row owns. jsdom has no layout engine, so a test that checked
// indentation by computed style would assert nothing while looking rigorous —
// the arithmetic is checked here, and the component test checks only that the
// number reaches the DOM.
//
// The invariant behind every case below: the list that goes in comes out the
// same length, in the same order. A bad depth costs a row its indent, never its
// place in the plan.

import { describe, expect, it } from 'vitest';
import { annotate, counts, normalizeDepths, INDENT_PX, MAX_DEPTH } from './todoTree';

const row = (status: string, depth?: number) => (depth === undefined ? { status } : { status, depth });
const pending = (depth?: number) => row('pending', depth);
const done = (depth?: number) => row('completed', depth);

describe('normalizeDepths', () => {
  it('reads an absent depth as top level — the shape every list had before nesting', () => {
    expect(normalizeDepths([pending(), pending(), pending()])).toEqual([0, 0, 0]);
  });

  it('passes a well-formed outline through untouched', () => {
    const list = [pending(0), pending(1), pending(2), pending(1), pending(0)];
    expect(normalizeDepths(list)).toEqual([0, 1, 2, 1, 0]);
  });

  it('clamps the FIRST row to 0 — there is nothing above it to be a child of', () => {
    expect(normalizeDepths([pending(2), pending(3)])).toEqual([0, 1]);
  });

  it('holds a row to one level below the row before it, so a jump cannot indent under nothing', () => {
    // 0 -> 3 claims a child of a parent two levels down that was never written.
    expect(normalizeDepths([pending(0), pending(3), pending(3)])).toEqual([0, 1, 2]);
  });

  it('allows any number of levels BACK out in one step (only descent is limited)', () => {
    expect(normalizeDepths([pending(0), pending(1), pending(2), pending(0)])).toEqual([0, 1, 2, 0]);
  });

  it(`caps depth at ${MAX_DEPTH} however deep the model goes`, () => {
    const deep = [pending(0), pending(1), pending(2), pending(3), pending(4), pending(9)];
    expect(normalizeDepths(deep)).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('floors a fractional depth and floors a negative one to 0', () => {
    expect(normalizeDepths([pending(0), pending(1.9), pending(-4)])).toEqual([0, 1, 0]);
  });

  it('reads NaN, Infinity and a non-number as 0 rather than dropping the row', () => {
    const junk = [
      pending(0),
      pending(Number.NaN),
      pending(Number.POSITIVE_INFINITY),
      { status: 'pending', depth: '1' as unknown as number },
    ];
    expect(normalizeDepths(junk)).toEqual([0, 0, 0, 0]);
    expect(normalizeDepths(junk)).toHaveLength(junk.length);
  });

  it('returns nothing for an empty list', () => {
    expect(normalizeDepths([])).toEqual([]);
  });

  it('never drops or reorders — one depth out per row in, whatever came in', () => {
    const list = [pending(5), pending(-1), pending(Number.NaN), pending(2), pending(0)];
    expect(normalizeDepths(list)).toHaveLength(list.length);
  });
});

describe('annotate — subtree tallies', () => {
  it('counts a parent’s DIRECT children', () => {
    const rows = annotate([pending(0), done(1), pending(1), pending(0)]);
    expect([rows[0].childDone, rows[0].childTotal]).toEqual([1, 2]);
    expect([rows[3].childDone, rows[3].childTotal]).toEqual([0, 0]);
  });

  it('counts grandchildren too — the top of a plan reports the WHOLE plan', () => {
    // root > child > two grandchildren, one of them done.
    const rows = annotate([pending(0), pending(1), done(2), pending(2)]);
    expect([rows[0].childDone, rows[0].childTotal]).toEqual([1, 3]);
    expect([rows[1].childDone, rows[1].childTotal]).toEqual([1, 2]);
    expect([rows[2].childTotal, rows[3].childTotal]).toEqual([0, 0]);
  });

  it('stops a subtree at the next row of equal or lesser depth', () => {
    // Two roots, each with one child. The first root must NOT claim the second.
    const rows = annotate([pending(0), done(1), pending(0), done(1)]);
    expect(rows[0].childTotal).toBe(1);
    expect(rows[2].childTotal).toBe(1);
  });

  it('counts against the NORMALISED depths, not the raw ones', () => {
    // Raw 0,3 would look like a grandchild; normalised it is a direct child, and
    // either way the row is the first row's descendant.
    const rows = annotate([pending(0), done(3)]);
    expect(rows[1].depth).toBe(1);
    expect([rows[0].childDone, rows[0].childTotal]).toEqual([1, 1]);
  });

  it('gives a flat list zero children everywhere — the pre-nesting shape, unchanged', () => {
    const rows = annotate([pending(), done(), pending()]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.childTotal)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.childDone)).toEqual([0, 0, 0]);
  });

  it('handles a list that is ALL children of its first row', () => {
    const rows = annotate([pending(0), done(1), done(1), done(1)]);
    expect([rows[0].childDone, rows[0].childTotal]).toEqual([3, 3]);
  });

  it('returns an empty list for an empty list', () => {
    expect(annotate([])).toEqual([]);
  });

  it('keeps every field of the row it was given', () => {
    const rows = annotate([{ status: 'pending', content: 'ship it', id: 7 }]);
    expect(rows[0]).toMatchObject({ status: 'pending', content: 'ship it', id: 7, depth: 0 });
  });
});

describe('counts', () => {
  it('tallies the three states, reading anything unrecognised as completed (the strip’s prior rule)', () => {
    expect(counts([pending(), row('in_progress'), done(), row('cancelled')])).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 2,
      total: 4,
    });
  });

  it('reports zeroes for an empty list', () => {
    expect(counts([])).toEqual({ pending: 0, in_progress: 0, completed: 0, total: 0 });
  });

  // A major is a CONTAINER, not work. Counting it as well counts the same plan
  // twice — once as the parent and once as everything under it — so a header
  // over one major with two sub-tasks would say 3 tasks where the user sees 2.
  it('counts LEAVES only — a row with children is a container, not a task', () => {
    // major(0) > two subs(1); the second sub is done.
    expect(counts([pending(0), pending(1), done(1)])).toEqual({
      pending: 1,
      in_progress: 0,
      completed: 1,
      total: 2,
    });
  });

  it('leaves a parent out however its own status reads', () => {
    // A parent marked completed over an unfinished child must not add to the
    // done tally — the branch under it is what is or is not done.
    expect(counts([done(0), pending(1)])).toEqual({ pending: 1, in_progress: 0, completed: 0, total: 1 });
  });

  it('counts a grandparent, a parent and a leaf as ONE task', () => {
    expect(counts([done(0), done(1), done(2)])).toEqual({
      pending: 0,
      in_progress: 0,
      completed: 1,
      total: 1,
    });
  });

  it('leaves a flat list exactly as it was — every row is a leaf', () => {
    expect(counts([done(), done(), pending()])).toEqual({
      pending: 1,
      in_progress: 0,
      completed: 2,
      total: 3,
    });
  });

  it('reads containers off the NORMALISED depths, not the raw ones', () => {
    // Raw 0,3 is a jump; normalised it is parent + child, so the first row is a
    // container and only the second is counted.
    expect(counts([pending(0), done(3)])).toEqual({ pending: 0, in_progress: 0, completed: 1, total: 1 });
  });
});

describe('INDENT_PX', () => {
  it('is a positive step, so a nested row is visibly offset from its parent', () => {
    expect(INDENT_PX).toBeGreaterThan(0);
  });
});
