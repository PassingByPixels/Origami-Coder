// Pure tests for labyrinthSearch.ts. The rule worth the test is the one a
// screenshot cannot show: a collab HEADER survives when a MEMBER matches. Drop
// the header and the member row goes with it — it is only reachable underneath
// its header — so search would delete the only route to the run it found.
import { describe, expect, it } from 'vitest';
import { filterIndex, matchCount } from './labyrinthSearch';
import { collabIndex, type CollabRow } from './labyrinthCollabIndex';

const row = (over: Partial<CollabRow> & { sessionId: string }): CollabRow => ({
  title: 'a run', folder: 'origami-coder', updatedAt: '2026-08-01T10:00:00.000Z', ...over,
});

// One plain run, and one collab whose members are the only place its agent
// slugs appear — the header itself says "2 agents" and nothing more.
const ROWS: CollabRow[] = [
  row({ sessionId: 'ses_plain', title: 'Fix the dry-run crash', folder: 'spark' }),
  row({ sessionId: 'ses_m1', collabId: 'c1', collabTitle: 'Wave 9 sweep', agentSlug: 'cartographer', title: 'map the repo' }),
  row({ sessionId: 'ses_m2', collabId: 'c1', collabTitle: 'Wave 9 sweep', agentSlug: 'scribe', title: 'write the notes' }),
];
const GROUPS = () => collabIndex(ROWS);

describe('filterIndex — an empty query is not a filter', () => {
  it('returns the SAME array for an empty or whitespace query, so "no filter" cannot reorder the index', () => {
    const groups = GROUPS();
    expect(filterIndex(groups, '')).toBe(groups);
    expect(filterIndex(groups, '   ')).toBe(groups);
  });
});

describe('filterIndex — plain runs', () => {
  it('matches a title, case-insensitively', () => {
    expect(filterIndex(GROUPS(), 'DRY-RUN').map((g) => g.pickId)).toEqual(['ses_plain']);
  });

  it('matches a folder', () => {
    expect(filterIndex(GROUPS(), 'spark').map((g) => g.pickId)).toEqual(['ses_plain']);
  });

  it('a query nothing matches returns nothing — not the unfiltered list', () => {
    expect(filterIndex(GROUPS(), 'zzz-no-such-run')).toEqual([]);
  });
});

describe('filterIndex — a collab header survives on its members', () => {
  it('keeps the header when only a MEMBER matches, carrying just that member', () => {
    const out = filterIndex(GROUPS(), 'scribe');
    expect(out).toHaveLength(1);
    expect(out[0]!.pickId).toBe('collab:c1');
    expect(out[0]!.members.map((m) => m.sessionId)).toEqual(['ses_m2']);
  });

  it('matches a member on its title as well as its slug', () => {
    const out = filterIndex(GROUPS(), 'write the notes');
    expect(out[0]!.members.map((m) => m.sessionId)).toEqual(['ses_m2']);
  });

  it('a header that matches on its OWN fields keeps ALL its members', () => {
    const out = filterIndex(GROUPS(), 'wave 9');
    expect(out).toHaveLength(1);
    expect(out[0]!.members.map((m) => m.sessionId)).toEqual(['ses_m1', 'ses_m2']);
  });

  it('the header its members were filtered under is a COPY — the unfiltered index still holds both', () => {
    const groups = GROUPS();
    filterIndex(groups, 'scribe');
    expect(groups.find((g) => g.pickId === 'collab:c1')!.members).toHaveLength(2);
  });

  it('matches the "N agents" subtitle, which is the header’s own text', () => {
    expect(filterIndex(GROUPS(), '2 agents').map((g) => g.pickId)).toEqual(['collab:c1']);
  });
});

describe('matchCount — what the head prints shown/total from', () => {
  it('counts every ROW offered, headers and member rows alike', () => {
    expect(matchCount(GROUPS())).toBe(4); // 1 plain + 1 header + 2 members
  });

  it('drops with the filter, so shown/total says what was removed', () => {
    expect(matchCount(filterIndex(GROUPS(), 'scribe'))).toBe(2); // header + the one member
  });

  it('is 0 when nothing matches — the pane’s third empty state', () => {
    expect(matchCount(filterIndex(GROUPS(), 'zzz-no-such-run'))).toBe(0);
  });
});
