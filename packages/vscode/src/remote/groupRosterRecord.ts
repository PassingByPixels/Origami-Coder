// The roster record as globalState holds it, read back into a GroupRoster.
// Extracted from groupMembers.ts (t-sfyata), which sat at its cap when the
// roster gained its gossip fields. Pure: a record of any other shape reads as
// ABSENT rather than repaired, because globalState is a file another build
// could have left in any shape.

import { isDeviceId } from './groupCrypto';
import { readDeskOs } from './deskOs';
import type { GroupMember, GroupRoster } from './groupMembers';

export function parseGroupRoster(raw: unknown): GroupRoster {
  const rec = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as {
    members?: unknown;
    motherBase?: unknown;
    motherBaseAt?: unknown;
    removed?: unknown;
    removedAt?: unknown;
  };
  // t-t8khdv stamps (groupMembership.ts): a missing or malformed one reads as 0, the oldest.
  const stamp = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const stamps = (rec.removedAt && typeof rec.removedAt === 'object' ? rec.removedAt : {}) as Record<string, unknown>;
  const removed = Array.isArray(rec.removed) ? [...new Set(rec.removed.filter(isDeviceId))] : [];
  const members: GroupMember[] = [];
  for (const value of Array.isArray(rec.members) ? rec.members : []) {
    const m = value as Partial<GroupMember> | null;
    if (!m || !isDeviceId(m.id)) continue;
    members.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : '',
      addedAt: typeof m.addedAt === 'number' && m.addedAt > 0 ? m.addedAt : 0,
      os: readDeskOs(m.os),
      lastSeen: typeof m.lastSeen === 'number' && m.lastSeen > 0 ? m.lastSeen : 0,
      admittedAt: stamp(m.admittedAt),
    });
  }
  return {
    members,
    motherBase: isDeviceId(rec.motherBase) ? rec.motherBase : null,
    motherBaseAt: typeof rec.motherBaseAt === 'number' && rec.motherBaseAt > 0 ? rec.motherBaseAt : 0,
    removed,
    removedAt: Object.fromEntries(removed.map((id) => [id, Object.hasOwn(stamps, id) ? stamp(stamps[id]) : 0])),
  };
}
