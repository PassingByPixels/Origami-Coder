// Which rows a collapsed tree still shows, and which parents start shut.
//
// Assertions rather than a rendered strip, for the same reason todoTree.test.ts
// is: jsdom has no layout engine, so "the sub-tasks are hidden" can only be
// checked as rows present or absent, and that decision is arithmetic. The
// component test checks that the decision reaches the DOM; the decision itself
// is here.

import { describe, expect, it } from 'vitest';
import { annotate } from './todoTree';
import { autoCollapsed, visible } from './todoCollapse';

const row = (status: string, depth?: number) => (depth === undefined ? { status } : { status, depth });
const rows = (...items: { status: string; depth?: number }[]) => annotate(items);

describe('autoCollapsed', () => {
  it('shuts a parent whose whole branch has settled', () => {
    expect(autoCollapsed(rows(row('completed', 0), row('completed', 1), row('cancelled', 1)))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('leaves a parent OPEN while any descendant is still pending', () => {
    expect(autoCollapsed(rows(row('completed', 0), row('completed', 1), row('pending', 1)))[0]).toBe(false);
  });

  it('leaves a parent open while a descendant is in_progress', () => {
    expect(autoCollapsed(rows(row('in_progress', 0), row('in_progress', 1)))[0]).toBe(false);
  });

  it('counts `failed` as settled — it is an outcome, not open work', () => {
    expect(autoCollapsed(rows(row('completed', 0), row('failed', 1)))[0]).toBe(true);
  });

  it('never shuts a leaf — there is nothing under it to hide', () => {
    expect(autoCollapsed(rows(row('completed'), row('completed')))).toEqual([false, false]);
  });

  it('holds a GRANDPARENT open on an open grandchild', () => {
    expect(autoCollapsed(rows(row('completed', 0), row('completed', 1), row('pending', 2)))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('answers nothing for an empty list', () => {
    expect(autoCollapsed([])).toEqual([]);
  });
});

describe('visible', () => {
  const three = () => rows(row('pending', 0), row('pending', 1), row('pending', 1), row('pending', 0));

  it('shows every row when nothing is collapsed', () => {
    expect(visible(three(), [false, false, false, false])).toHaveLength(4);
  });

  it('drops a collapsed parent’s children but keeps the parent and its siblings', () => {
    const shown = visible(three(), [true, false, false, false]);
    expect(shown).toHaveLength(2);
    expect(shown.map((r) => r.depth)).toEqual([0, 0]);
  });

  // The whole subtree goes with the row that closed, not one level of it.
  it('drops GRANDCHILDREN too', () => {
    const deep = rows(row('pending', 0), row('pending', 1), row('pending', 2), row('pending', 0));
    expect(visible(deep, [true, false, false, false]).map((r) => r.depth)).toEqual([0, 0]);
  });

  it('ignores a collapse flag on a leaf — a stale flag cannot delete rows', () => {
    expect(visible(three(), [false, true, true, true])).toHaveLength(4);
  });

  it('keeps a nested collapse harmless once its parent is already collapsed', () => {
    const deep = rows(row('pending', 0), row('pending', 1), row('pending', 2), row('pending', 0));
    expect(visible(deep, [true, true, false, false]).map((r) => r.depth)).toEqual([0, 0]);
  });

  it('reads a missing flag as expanded', () => {
    expect(visible(three(), [])).toHaveLength(4);
  });

  it('returns an empty list for an empty list', () => {
    expect(visible([], [])).toEqual([]);
  });
});
