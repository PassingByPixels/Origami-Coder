// Pure-logic tests for chatSections.ts — no DOM, no component render. Both
// functions are load-bearing for ChatsList: a grouping bug here would put a
// chat in the wrong section (or drop it), and a clamp bug would let the
// Collabs divider crush a half to nothing.
import { describe, expect, it } from 'vitest';
import { groupSessionIds, clampCollabsHeight, defaultChatSectionsState } from './chatSections';

describe('groupSessionIds', () => {
  const known = new Set(['sec1', 'sec2']);

  it('splits an ordered id list into main/bySection, each keeping order', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const membership = { b: 'sec1', d: 'sec1', e: 'sec2' };
    expect(groupSessionIds(order, membership, known)).toEqual({
      main: ['a', 'c'],
      bySection: { sec1: ['b', 'd'], sec2: ['e'] },
    });
  });

  it('every chat is in Main when membership is empty', () => {
    expect(groupSessionIds(['a', 'b'], {}, known)).toEqual({ main: ['a', 'b'], bySection: {} });
  });

  it('a membership entry for an id no longer in the order list is silently dropped, not invented as a row', () => {
    const order = ['a'];
    const membership = { a: 'sec1', ghost: 'sec1' };
    expect(groupSessionIds(order, membership, known)).toEqual({ main: [], bySection: { sec1: ['a'] } });
  });

  it('an ORPHANED membership entry (section deleted, or not yet known) lands the chat in MAIN, never dropped', () => {
    const order = ['a', 'b'];
    const membership = { a: 'sec-deleted', b: 'sec1' };
    expect(groupSessionIds(order, membership, known)).toEqual({ main: ['a'], bySection: { sec1: ['b'] } });
  });

  // t-r43glr: 'loops' is not a known section any more — a stale membership
  // entry still carrying it (from before the built-in was retired) must land
  // in Main exactly like any other orphan, not error or vanish.
  it('a membership entry naming the retired built-in "loops" lands the chat in MAIN, never dropped', () => {
    const order = ['a', 'b'];
    const membership = { a: 'loops', b: 'sec1' };
    expect(groupSessionIds(order, membership, known)).toEqual({ main: ['a'], bySection: { sec1: ['b'] } });
  });

  it('multiple custom sections each get their own bucket, in order', () => {
    const order = ['a', 'b', 'c', 'd'];
    const membership = { a: 'sec2', b: 'sec1', c: 'sec2', d: 'sec1' };
    expect(groupSessionIds(order, membership, known).bySection).toEqual({
      sec1: ['b', 'd'],
      sec2: ['a', 'c'],
    });
  });

  it('an empty order list produces empty sections', () => {
    expect(groupSessionIds([], { a: 'sec1' }, known)).toEqual({ main: [], bySection: {} });
  });
});

describe('clampCollabsHeight', () => {
  it('passes a candidate through unchanged when it is well within bounds', () => {
    expect(clampCollabsHeight(200, 600)).toBe(200);
  });

  it('floors at the minimum — the Collabs half cannot be dragged to nothing', () => {
    expect(clampCollabsHeight(10, 600)).toBe(60);
    expect(clampCollabsHeight(-500, 600)).toBe(60);
  });

  it('ceils so the Chats half keeps at least the same minimum', () => {
    expect(clampCollabsHeight(590, 600)).toBe(540);
  });

  it('rounds a fractional candidate to a whole pixel', () => {
    expect(clampCollabsHeight(200.6, 600)).toBe(201);
  });

  it('a custom minimum is honoured on both ends', () => {
    expect(clampCollabsHeight(5, 200, 30)).toBe(30);
    expect(clampCollabsHeight(195, 200, 30)).toBe(170);
  });

  it('a container too small for even one minimum on each side still returns a finite, non-negative height', () => {
    expect(clampCollabsHeight(30, 50)).toBe(60);
  });
});

describe('defaultChatSectionsState', () => {
  it('starts with no membership, no custom sections, and Main expanded', () => {
    const s = defaultChatSectionsState();
    expect(s.membership).toEqual({});
    expect(s.sections).toEqual([]);
    expect(s.mainCollapsed).toBe(false);
  });
});
