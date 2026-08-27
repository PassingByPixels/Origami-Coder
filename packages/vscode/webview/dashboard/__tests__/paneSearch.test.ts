// paneSearch — the filter box shared by the Crons and Loops panes.
//
// The behaviour worth pinning is not "substring matching works". It is the
// EMPTY-STATE DISCRIMINATION: "you have no crons" and "your filter matched no
// crons" are different facts about the user's data, and printing the first when
// the second is true tells someone their scheduled work is gone.

import { describe, it, expect } from 'vitest';
import { listState, matchesSearch } from '../panes/paneSearch';

describe('paneSearch — matching', () => {
  it('an empty or whitespace query matches everything (no filter excludes nothing)', () => {
    expect(matchesSearch(['nightly triage'], '')).toBe(true);
    expect(matchesSearch(['nightly triage'], '   ')).toBe(true);
  });

  it('is case-insensitive and matches inside a word', () => {
    expect(matchesSearch(['Nightly Triage'], 'ightly')).toBe(true);
  });

  it('requires EVERY term (AND), so a second word narrows rather than widens', () => {
    // The bug: OR semantics, where typing more makes the list longer. Nobody
    // types a second word hoping for more results.
    expect(matchesSearch(['nightly triage', 'daily at 09:30'], 'nightly daily')).toBe(true);
    expect(matchesSearch(['nightly triage', 'daily at 09:30'], 'nightly weekly')).toBe(false);
  });

  it('searches across all nominated fields, not just the first', () => {
    expect(matchesSearch(['nightly', 'sweep the backlog'], 'backlog')).toBe(true);
  });

  it('absent fields never become searchable text', () => {
    // The bug: joining fields with String(f) turns a missing model into the
    // literal "undefined", so typing "undefined" matches every row that lacks
    // one — and, worse, "def" matches them too.
    expect(matchesSearch(['nightly', undefined, null], 'undefined')).toBe(false);
    expect(matchesSearch(['nightly', undefined, null], 'null')).toBe(false);
  });

  it('a term that appears in no field does not match', () => {
    expect(matchesSearch(['nightly triage'], 'weekly')).toBe(false);
  });
});

describe('paneSearch — "nothing exists" is never confused with "nothing matched"', () => {
  it('no rows at all is empty', () => {
    expect(listState(0, 0)).toBe('empty');
  });

  it('rows exist but none survived the filter is no-matches, NOT empty', () => {
    expect(listState(12, 0)).toBe('no-matches');
  });

  it('rows that survived the filter are has-rows', () => {
    expect(listState(12, 3)).toBe('has-rows');
  });
});
