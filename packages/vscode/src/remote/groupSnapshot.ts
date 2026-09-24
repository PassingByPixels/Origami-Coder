// What the pane and the nest draw of the device group: one row per desk.
// Extracted from groupController.ts (t-sc093o), which sat at its cap when the
// nest verbs needed a send and a message hook there. Pure: the controller
// passes what it holds, this builds the view.

import type { DeskOs } from './deskOs';
import type { GroupRoster } from './groupMembers';
import type { JoinCheck } from './groupHandshake';

export interface GroupDeviceView {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
  motherBase: boolean;
  os: DeskOs;
  lastSeen: number;
}

export interface GroupSnapshot {
  /** True once this desk holds Kg. */
  active: boolean;
  deviceId: string | null;
  devices: GroupDeviceView[];
  /** The string the QR draws and the paste box takes, while an invite stands. */
  inviteKey: string | null;
  inviteExpiresAt: number | null;
  /** t-sj32zl: a join in flight, the joining desk's name and the match code. */
  joinCheck: JoinCheck | null;
  /** Why the last join ended with no welcome (declined, ran out), or null. */
  joinNotice: string | null;
}

/** A window with no controller, or Nests off: nothing in flight. */
export const NO_JOIN = { inviteKey: null, inviteExpiresAt: null, joinCheck: null, joinNotice: null } as const;

export function groupDevices(
  roster: GroupRoster,
  self: string | null,
  online: ReadonlySet<string>,
  selfOs: DeskOs | undefined,
): GroupDeviceView[] {
  return roster.members.map((m) => ({
    id: m.id,
    name: m.name,
    self: m.id === self,
    // This desk is online by definition; a peer is online once its hello landed.
    online: m.id === self || online.has(m.id),
    motherBase: roster.motherBase === m.id,
    os: m.id === self ? (selfOs ?? m.os) : m.os,
    lastSeen: m.lastSeen,
  }));
}
