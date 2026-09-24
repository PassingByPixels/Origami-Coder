// WHO IS IN THE GROUP, as an order every desk computes the same way
// (t-t8khdv). A desk keeps its id for life (t-t7l3pa), so a removed desk that
// is invited again comes back under the SAME id. "A removal is final" then
// kept it out on every desk but its inviter.
//
// THE RULE. Each member row carries `admittedAt` and each tombstone a stamp in
// `removedAt`. Per id, the later of the two wins. On a tie the REMOVAL wins, so
// every desk settles the same way and the safe side takes the draw. A missing
// stamp (an old frame, an old globalState record) counts as 0, the oldest.
// The desk that writes a fact stamps it past the fact it replaces: a
// re-admission at max(now, tombstone + 1), a removal at max(now, admission + 1),
// so a slow clock on that desk still orders its own acts.
//
// A tombstone that lost to a newer admission is deleted, so it never takes a
// place under the cap. The cap keeps the GROUP_REMOVED_MAX newest tombstones
// (by stamp, then id): the same set on every desk.
//
// Pure: groupMembers.ts writes with these, groupGossip.ts merges with them.
// Stamps are read with hasOwn: 'constructor' is a well-formed device id.

import type { GroupMember, GroupRoster } from './groupMembers';

/** Tombstones kept. */
export const GROUP_REMOVED_MAX = 64;

const tombAt = (r: GroupRoster, id: string): number =>
  r.removedAt && Object.hasOwn(r.removedAt, id) ? r.removedAt[id]! : 0;
const stampsOf = (r: GroupRoster): Map<string, number> => new Map(r.removed.map((id) => [id, tombAt(r, id)]));

/** The newest `GROUP_REMOVED_MAX` tombstones, oldest first. */
export function capTombstones(stamps: Map<string, number>): Pick<GroupRoster, 'removed' | 'removedAt'> {
  const removed = [...stamps.keys()]
    .sort((a, b) => stamps.get(a)! - stamps.get(b)! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(-GROUP_REMOVED_MAX);
  return { removed, removedAt: Object.fromEntries(removed.map((id) => [id, stamps.get(id)!])) };
}

/** Admit `member` into `next` (mutated). A tombstone of the same id is lifted
 *  and the admission stamped past it. With no tombstone the stamp stays 0, so
 *  a desk that only LEARNS of a member never outbids a removal it has not seen. */
export function admitMember(next: GroupRoster, member: GroupMember, at: number): void {
  if (next.removed.includes(member.id)) {
    member.admittedAt = Math.max(at, tombAt(next, member.id) + 1);
    const stamps = stampsOf(next);
    stamps.delete(member.id);
    Object.assign(next, capTombstones(stamps));
  }
  next.members.push(member);
}

/** Remove `id` from `next` (mutated), stamped past its admission. */
export function tombstoneMember(next: GroupRoster, id: string, at: number): void {
  const admitted = next.members.find((m) => m.id === id)?.admittedAt ?? 0;
  next.members = next.members.filter((m) => m.id !== id);
  const stamps = stampsOf(next);
  stamps.set(id, Math.max(at, admitted + 1, stamps.get(id) ?? 0));
  Object.assign(next, capTombstones(stamps));
}

/** Both sides' facts per id: the latest admission and the live tombstones.
 *  `self` is never removed. `dead(id)` says the removal won. */
export function mergeStamps(local: GroupRoster, theirs: GroupRoster, self: string) {
  const admitted = new Map<string, number>();
  for (const m of [...local.members, ...theirs.members]) admitted.set(m.id, Math.max(admitted.get(m.id) ?? 0, m.admittedAt ?? 0));
  const removals = new Map<string, number>();
  for (const r of [local, theirs]) {
    for (const id of r.removed) if (id !== self) removals.set(id, Math.max(removals.get(id) ?? 0, tombAt(r, id)));
  }
  // An id with no member row on either side stays removed; a tie goes to the removal.
  const dead = (id: string): boolean => removals.has(id) && (admitted.get(id) ?? -1) <= removals.get(id)!;
  const live = new Map([...removals].filter(([id]) => dead(id)));
  return { admitted, tombstones: capTombstones(live), dead };
}

/** What the gossip compares to decide "changed": ids with their stamps, sorted. */
export function membershipKey(r: GroupRoster): string {
  const members = r.members.map((m) => `${m.id}@${m.admittedAt ?? 0}`).sort();
  const removed = r.removed.map((id) => `${id}@${tombAt(r, id)}`).sort();
  return `${members.join(',')}|${removed.join(',')}`;
}
