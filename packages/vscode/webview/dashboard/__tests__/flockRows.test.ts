// flockRows.ts — the four pure answers a contact row needs.
//
// Three of them have a WRONG answer that a rendered test would not catch: the
// wrong name on the first line, the wrong row surviving a search, and the same
// colour on two people the search exists to tell apart. The rendered half of
// this feature (flockPane.test.ts) proves the box is wired to the filter; this
// proves the filter.

import { describe, expect, it } from 'vitest';
import { ICON_DEFAULT, avatarTint, displayNameOf, filterFriends, iconOf, policyChip } from '../panes/flockRows';
import type { FlockFriendRow } from '../panes/flockTypes';

const FP = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';

function friend(over: Partial<FlockFriendRow> & { name: string }): FlockFriendRow {
  return {
    handle: `${over.name}@${FP}`,
    handleShort: `${over.name}@${FP.slice(0, 8)}`,
    addedAt: '2026-08-30T11:00:00.000Z',
    policy: {},
    spentToday: 0,
    effective: { autoAnswer: false },
    ...over,
  };
}

describe('displayNameOf — which of the two names leads', () => {
  it('prefers the owner\'s own label and falls back to the declared name', () => {
    expect(displayNameOf({ name: 'dana', displayName: 'Dana from the gym' })).toBe('Dana from the gym');
    expect(displayNameOf({ name: 'dana' })).toBe('dana');
  });

  it('treats a blank label as no label rather than rendering an empty first line', () => {
    // The engine trims and drops a blank one, but a `flock.json` written by
    // hand can still carry "   " — and a row whose name is three spaces is a
    // row with no name at all.
    expect(displayNameOf({ name: 'dana', displayName: '   ' })).toBe('dana');
    expect(displayNameOf({ name: 'dana', displayName: '' })).toBe('dana');
  });
});

describe('iconOf — which sigil a row draws', () => {
  it('takes the id the row carries', () => {
    expect(iconOf({ icon: 'fox' })).toBe('fox');
  });

  it('falls back to the brand mark for a row that names none', () => {
    // An extension and an engine ship separately, so "no icon on the row" is
    // not hypothetical: it is every row an engine built before the field.
    expect(iconOf({})).toBe(ICON_DEFAULT);
    expect(iconOf({ icon: '' })).toBe(ICON_DEFAULT);
    expect(iconOf({ icon: '   ' })).toBe(ICON_DEFAULT);
  });
});

describe('the retired initials helper', () => {
  it('is gone, because a contact row draws THEIR sigil now', async () => {
    // The avatar was a two-letter hash of a name this owner may have typed
    // themselves. It is the contact's own mark instead, so the helper has no
    // caller — and a helper with no caller is a thing to delete, not to keep
    // a test for.
    const rows = (await import('../panes/flockRows')) as Record<string, unknown>;
    expect(rows['initials']).toBeUndefined();
  });

});

describe('avatarTint — the colour that tells two rows apart', () => {
  it('is one of the four theme vars, and is stable for one handle', () => {
    const tint = avatarTint(`dana@${FP}`);
    expect(tint).toMatch(/^var\(--og-(chat|accent-2|success|status-waiting)\)$/);
    expect(avatarTint(`dana@${FP}`)).toBe(tint);
  });

  it('keys off the WHOLE handle, so two contacts with one name still differ', () => {
    // Two Danas differ only in their fingerprint. Hashing the display name — or
    // the name segment — would give both the same circle, in the one pane whose
    // job is telling them apart.
    const a = avatarTint(`dana@${FP}`);
    const b = avatarTint(`dana@${FP.replace(/^Zm9v/, 'YWJj')}`);
    expect(a === b).toBe(false);
  });
});

describe('filterFriends — the search box over the address book', () => {
  const flock = [
    friend({ name: 'robin' }),
    friend({ name: 'dana', displayName: 'Dana from the gym', handle: `dana@YWJj${FP.slice(4)}` }),
    friend({ name: 'dana', displayName: 'Dana at work', handle: `dana@ZGVm${FP.slice(4)}` }),
  ];
  const names = (query: string) => filterFriends(flock, query).map((f) => displayNameOf(f));

  it('matches the owner\'s label anywhere in it', () => {
    expect(names('gym')).toEqual(['Dana from the gym']);
    expect(names('at work')).toEqual(['Dana at work']);
  });

  it('matches the DECLARED name too, which is the half a label hides', () => {
    // "dana" is nowhere in "Dana at work" as the owner typed it — it is in the
    // name she declared. A filter over the label alone would find one of two.
    expect(names('dana')).toEqual(['Dana from the gym', 'Dana at work']);
  });

  it('matches a handle from the START and not from the middle', () => {
    expect(names('dana@YWJj')).toEqual(['Dana from the gym']);
    // A substring match on 43 characters of base64 makes an arbitrary
    // three-character query hit half the flock for no reason a reader can see.
    expect(names(FP.slice(10, 18))).toEqual([]);
  });

  it('is case-insensitive on all three fields', () => {
    expect(names('GYM')).toEqual(['Dana from the gym']);
    expect(names('ROBIN')).toEqual(['robin']);
    expect(names(`DANA@YWJJ`)).toEqual(['Dana from the gym']);
  });

  it('returns EVERY contact for an empty or blank query, and a copy not the array', () => {
    // A box that hides the list until it is typed in is a list that has been
    // lost. And the result must not be the caller's array: the pane derives
    // from it, and a sort applied downstream would reorder the engine's state.
    expect(names('')).toHaveLength(3);
    expect(names('   ')).toHaveLength(3);
    expect(filterFriends(flock, '')).not.toBe(flock);
    expect(filterFriends([], 'anything')).toEqual([]);
  });
});

describe('policyChip — what a row says a contact may do', () => {
  it('names the answer mode and whether the scope is theirs or the default', () => {
    expect(policyChip(friend({ name: 'robin' }))).toBe('waits for you · default scope');
    expect(policyChip(friend({ name: 'dana', effective: { autoAnswer: true } }))).toBe('auto · default scope');
    expect(
      policyChip(friend({ name: 'ivy', policy: { scope: { repos: ['a'], wiki: ['b', 'c'] } } })),
    ).toBe('waits for you · 3 of their own');
  });
});
