// t-sfyata — the roster merge rule, one case per way a group could disagree.
// The three-desk end to end is in nestsWiring.test.ts; these are the cases it
// cannot stage in order: a stale roster after a removal, two marks at the same
// time, and a merge that changes nothing (which must not be sent on, or the
// gossip never stops).
import { describe, expect, it } from 'vitest';
import { mergeRoster, groupRosterMessage } from '../../../src/remote/groupGossip';
import { GroupRosterStore, type GroupRoster } from '../../../src/remote/groupMembers';
import { GROUP_REFUSALS } from '../../../src/remote/groupRefusals';

const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
const C = 'CCCCCCCCCCC';
const member = (id: string, name = '') => ({ id, name, addedAt: 1, os: '' as const, lastSeen: 0 });
const roster = (over: Partial<GroupRoster> = {}): GroupRoster => ({
  members: [member(A, 'MacBook'), member(B, '5090')], motherBase: null, motherBaseAt: 0, removed: [], ...over,
});

describe('roster gossip — the merge rule', () => {
  it('a desk heard of only through a peer is added, with the name that peer knows', () => {
    const got = mergeRoster(roster(), groupRosterMessage(B, roster({ members: [member(A), member(B), member(C, 'Surface')] })), A, 50);
    expect(got.added).toEqual([C]);
    expect(got.changed).toBe(true);
    expect(got.next.members.find((m) => m.id === C)).toMatchObject({ name: 'Surface', addedAt: 50 });
  });

  it('a removal beats a member: a stale roster that still lists the desk does not bring it back', () => {
    const removed = mergeRoster(roster({ members: [member(A), member(B), member(C)] }), roster({ removed: [C] }), A, 1);
    expect(removed.removed).toEqual([C]);
    expect(removed.next.members.map((m) => m.id)).toEqual([A, B]);
    const stale = mergeRoster(removed.next, roster({ members: [member(A), member(B), member(C)] }), A, 2);
    expect(stale.added).toEqual([]);
    expect(stale.changed).toBe(false);
    expect(stale.next.members.map((m) => m.id)).toEqual([A, B]);
  });

  it('a desk never removes itself, and never adds itself as a peer', () => {
    const got = mergeRoster(roster(), roster({ removed: [A] }), A, 1);
    expect(got.next.members.map((m) => m.id)).toContain(A);
    expect(got.next.removed).toEqual([]);
    expect(got.changed).toBe(false);
  });

  it('mother base: the later mark wins; on the same time the greater id wins, on both desks', () => {
    const later = mergeRoster(roster({ motherBase: A, motherBaseAt: 10 }), roster({ motherBase: B, motherBaseAt: 20 }), A, 1);
    expect(later.next).toMatchObject({ motherBase: B, motherBaseAt: 20 });
    const earlier = mergeRoster(roster({ motherBase: A, motherBaseAt: 30 }), roster({ motherBase: B, motherBaseAt: 20 }), A, 1);
    expect(earlier.next.motherBase).toBe(A);
    expect(earlier.changed).toBe(false);
    // Two desks marked different desks at the same millisecond: both settle on B.
    const onA = mergeRoster(roster({ motherBase: A, motherBaseAt: 5 }), roster({ motherBase: B, motherBaseAt: 5 }), A, 1);
    const onB = mergeRoster(roster({ motherBase: B, motherBaseAt: 5 }), roster({ motherBase: A, motherBaseAt: 5 }), B, 1);
    expect([onA.next.motherBase, onB.next.motherBase]).toEqual([B, B]);
  });

  it('a mother base that was removed is cleared', () => {
    const got = mergeRoster(roster({ motherBase: B, motherBaseAt: 9 }), roster({ removed: [B] }), A, 1);
    expect(got.next.motherBase).toBeNull();
  });

  it('the same roster again changes nothing, so it is not sent on', () => {
    const same = roster({ motherBase: B, motherBaseAt: 4, removed: [C] });
    expect(mergeRoster(same, groupRosterMessage(B, same), A, 1).changed).toBe(false);
  });

  it('malformed rows off the wire are dropped, not repaired', () => {
    const got = mergeRoster(roster(), { members: [{ id: 'short' }, null, { id: C }], removed: ['x', 7], motherBase: 'nope', motherBaseAt: 99 }, A, 1);
    expect(got.added).toEqual([C]);
    expect(got.next.removed).toEqual([]);
    expect(got.next.motherBase).toBeNull();
  });

  it('the phone never sends the roster: group/roster is a named refusal', () => {
    expect(GROUP_REFUSALS).toContain('group/roster');
  });
});

// t-t8khdv — a desk keeps its id for life, so a removed desk invited again has
// the SAME id. Per id the later of admission and removal wins; a tie is a removal.
describe('roster gossip — admission and removal stamps (t-t8khdv)', () => {
  const stamped = (id: string, admittedAt: number) => ({ ...member(id), admittedAt });
  const ids = (r: GroupRoster) => r.members.map((m) => m.id).sort();

  it('an admission newer than a tombstone beats it: the desk is added and the tombstone goes', () => {
    const local = roster({ removed: [C], removedAt: { [C]: 10 } });
    const got = mergeRoster(local, groupRosterMessage(B, roster({ members: [member(A), member(B), stamped(C, 11)] })), A, 50);
    expect(got.added).toEqual([C]);
    expect(got.next.removed).toEqual([]);
    expect(got.changed).toBe(true);
  });

  it('a tombstone newer than the admission removes the desk, and a stale roster does not bring it back', () => {
    const local = roster({ members: [member(A), member(B), stamped(C, 11)] });
    const got = mergeRoster(local, groupRosterMessage(B, roster({ removed: [C], removedAt: { [C]: 12 } })), A, 1);
    expect(got.removed).toEqual([C]);
    expect(ids(got.next)).toEqual([A, B]);
    const stale = mergeRoster(got.next, roster({ members: [member(A), member(B), stamped(C, 11)] }), A, 2);
    expect(stale.added).toEqual([]);
    expect(stale.changed).toBe(false);
  });

  it('the same stamp on both: the removal wins, on both desks, in either order', () => {
    const admitted = roster({ members: [member(A), member(B), stamped(C, 7)] });
    const removedR = roster({ removed: [C], removedAt: { [C]: 7 } });
    expect(ids(mergeRoster(admitted, removedR, A, 1).next)).toEqual([A, B]);
    expect(ids(mergeRoster(removedR, admitted, B, 1).next)).toEqual([A, B]);
  });

  it('a frame from an older build (no stamps) still merges: its facts count as the oldest', () => {
    const readmitted = roster({ members: [member(A), member(B), stamped(C, 11)] });
    const old = { members: [{ id: A, name: '' }, { id: B, name: '' }], removed: [C] };
    expect(ids(mergeRoster(readmitted, old, A, 1).next)).toEqual([A, B, C]);
    // And an old frame that lists C does not lift a stamped tombstone.
    const tomb = roster({ removed: [C], removedAt: { [C]: 3 } });
    expect(mergeRoster(tomb, { members: [{ id: C, name: '' }] }, A, 1).added).toEqual([]);
    // With no stamps on either side the old rule stands: the removal beats the member.
    expect(ids(mergeRoster(roster({ members: [member(A), member(B), member(C)] }), old, A, 1).next)).toEqual([A, B]);
  });

  it('the cap keeps the 64 newest tombstones, and a tombstone that lost to an admission takes no place', () => {
    const many = Array.from({ length: 64 }, (_, i) => `D${String(i).padStart(10, '0')}`);
    const local = roster({ removed: many, removedAt: Object.fromEntries(many.map((id, i) => [id, 100 + i])) });
    // C: removed at 5, admitted again at 6 by the peer. It must not push out any of the 64.
    const got = mergeRoster({ ...local, removed: [...many, C], removedAt: { ...local.removedAt, [C]: 5 } },
      roster({ members: [member(A), member(B), stamped(C, 6)] }), A, 1);
    expect(got.added).toEqual([C]);
    expect(got.next.removed).toEqual(many);
    // One more removal, newer than all: the OLDEST tombstone goes, the same one on every desk.
    const more = mergeRoster(got.next, roster({ removed: [B], removedAt: { [B]: 999 } }), A, 1);
    expect(more.next.removed).toEqual([...many.slice(1), B]);
  });

  it('a well-formed id that names an Object property is read as an id, not a prototype member', () => {
    const odd = 'constructor';
    const got = mergeRoster(roster({ removed: [odd] }), roster({ members: [member(A), member(B), stamped(odd, 2)] }), A, 1);
    expect(got.added).toEqual([odd]);
  });
});

describe('the roster store stamps its own acts past what it replaces (t-t8khdv)', () => {
  function store(): GroupRosterStore {
    const bag = new Map<string, unknown>();
    return new GroupRosterStore({ get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d), update: (k, v) => { bag.set(k, v); return Promise.resolve(); } });
  }

  it('re-admission beats the tombstone and a later removal beats the re-admission, even when the clock runs back', async () => {
    const s = store();
    await s.remember(C, 'Surface', 1_000);
    await s.forget(C, 2_000);
    expect(s.read().removedAt).toEqual({ [C]: 2_000 });
    await s.remember(C, 'Surface', 1_500); // the clock went back 500 ms
    expect(s.read().removed).toEqual([]);
    const admittedAt = s.read().members.find((m) => m.id === C)!.admittedAt!;
    expect(admittedAt).toBeGreaterThan(2_000);
    await s.forget(C, 1_700);
    expect(s.read().removedAt![C]).toBeGreaterThan(admittedAt);
  });

  it('a desk that only learns of a member does not stamp it, so it never outbids a removal it has not seen', async () => {
    const s = store();
    await s.remember(C, 'Surface', 9_000);
    expect(s.read().members[0]!.admittedAt).toBe(0);
  });
});
