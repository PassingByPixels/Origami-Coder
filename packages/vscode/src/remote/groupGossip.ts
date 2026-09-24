// ROSTER GOSSIP (t-sfyata): how a desk that joined through one desk becomes
// known to all the others.
//
//   group/roster   either -> either, on a PAIRWISE rid. The sender's whole
//                  roster: members, removals, and the mother-base flag with the
//                  time it moved. Sent after every hello and after every local
//                  change. The same fields also ride group/welcome.
//
// THE RULE. Members are a union. Per desk id, the later of its admission and
// its removal wins, and a removal wins a tie (t-t8khdv; the stamps and why are
// in groupMembership.ts). So a stale roster cannot bring a removed desk back,
// but a desk invited again after its removal is a member on every desk. A frame
// with no stamps (an older build) still merges: its stamps count as the oldest.
// The mother base is the flag with the later time; on a tie the greater id
// wins, so every desk picks the same one. A desk sends its roster on again only
// when a merge CHANGED it, so the gossip stops when all desks agree.
//
// Everything off the wire is UNTRUSTED: it goes through the same record reader
// as globalState, so a malformed row is dropped rather than repaired.

import type { GroupMember, GroupRoster } from './groupMembers';
import { membershipKey, mergeStamps } from './groupMembership';
import { parseGroupRoster } from './groupRosterRecord';

export const GROUP_ROSTER = 'group/roster';

/** The roster's fields as they go on the wire. */
export function rosterFields(roster: GroupRoster): Record<string, unknown> {
  return {
    members: roster.members.map((m) => ({ id: m.id, name: m.name, os: m.os, lastSeen: m.lastSeen, admittedAt: m.admittedAt ?? 0 })),
    removed: roster.removed,
    removedAt: roster.removedAt ?? {},
    motherBase: roster.motherBase,
    motherBaseAt: roster.motherBaseAt,
  };
}

export function groupRosterMessage(from: string, roster: GroupRoster): Record<string, unknown> {
  return { type: GROUP_ROSTER, from, ...rosterFields(roster) };
}

export interface RosterMerge {
  next: GroupRoster;
  /** Desks this desk had not heard of: each gets a pairwise link. */
  added: string[];
  /** Desks another desk removed: each loses its link here. */
  removed: string[];
  /** Membership, removals or the mother base moved: send the roster on. */
  changed: boolean;
}

const flagKey = (id: string | null, at: number): string => `${String(at).padStart(16, '0')}:${id ?? ''}`;

/** Merge a peer's roster into this desk's. Pure. `self` is never removed here
 *  and never added: a desk is not its own peer. */
export function mergeRoster(local: GroupRoster, raw: unknown, self: string, at: number): RosterMerge {
  const theirs = parseGroupRoster(raw);
  const { admitted, tombstones, dead } = mergeStamps(local, theirs, self);
  const gone = local.members.filter((m) => m.id !== self && dead(m.id)).map((m) => m.id);
  const members: GroupMember[] = local.members
    .filter((m) => !gone.includes(m.id))
    .map((m) => ({ ...m, admittedAt: admitted.get(m.id) ?? 0 }));
  const added: string[] = [];
  for (const m of theirs.members) {
    if (dead(m.id)) continue;
    const found = members.find((x) => x.id === m.id);
    if (found) {
      // A blank here is filled; a name this desk already holds is kept.
      if (!found.name) found.name = m.name;
      if (!found.os) found.os = m.os;
    } else if (m.id !== self) {
      members.push({ ...m, addedAt: at, admittedAt: admitted.get(m.id) ?? 0 });
      added.push(m.id);
    }
  }
  let { motherBase, motherBaseAt } = local;
  if (flagKey(theirs.motherBase, theirs.motherBaseAt) > flagKey(motherBase, motherBaseAt)) {
    motherBase = theirs.motherBase;
    motherBaseAt = theirs.motherBaseAt;
  }
  if (motherBase && tombstones.removed.includes(motherBase)) motherBase = null;
  const flagMoved = motherBase !== local.motherBase || motherBaseAt !== local.motherBaseAt;
  const next: GroupRoster = { members, motherBase, motherBaseAt, ...tombstones };
  return {
    next,
    added,
    removed: gone,
    changed: added.length > 0 || gone.length > 0 || flagMoved || membershipKey(next) !== membershipKey(local),
  };
}
