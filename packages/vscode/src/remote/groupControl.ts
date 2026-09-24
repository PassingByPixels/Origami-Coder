// The ONE seam between the activation-owned GroupController and the pane that
// drives it — the same shape, and for the same reason, as control.ts: with
// Nests off (t-s9jr6u) the controller must not be constructed at all, so
// activation REGISTERS here and a never-activated window answers "no group".

import type { GroupController, GroupSnapshot } from './groupController';
import { forgetMember, forgetRoster, renameMember, roster, setMotherBase } from './groupMembers';
import { NO_JOIN } from './groupSnapshot';

interface Registration {
  target: () => GroupController;
  enabled: () => boolean;
}

let registration: Registration | null = null;

export function registerGroupControl(reg: Registration): void {
  registration = reg;
}

/** What activation registered, or null. The join verbs read it (groupJoinControl.ts, t-sj32zl). */
export function registered(): Registration | null {
  return registration;
}

/** Test hook: put the module back to a never-activated window. */
export function resetGroupControl(): void {
  registration = null;
}

export { notifyGroupChange, onGroupChange } from './groupChange';

/** With Nests off the roster is still READ — a device list the owner cannot
 *  see is a device list they cannot clean up — but nothing connects. */
export function groupSnapshot(): GroupSnapshot {
  if (!registration || !registration.enabled()) {
    const { members, motherBase } = roster();
    return {
      active: false,
      deviceId: null,
      devices: members.map((m) => ({ ...m, self: false, online: false, motherBase: motherBase === m.id })),
      ...NO_JOIN,
    };
  }
  return registration.target().snapshot();
}

export async function groupMarkMotherBase(id: string | null): Promise<void> {
  if (!registration || !registration.enabled()) return setMotherBase(id);
  await registration.target().markMotherBase(id);
}

export async function groupRemoveDevice(id: string): Promise<void> {
  if (!registration || !registration.enabled()) return forgetMember(id);
  await registration.target().removeDevice(id);
}

/** A name is desktop-side and goes nowhere near the wire until the next hello. */
export async function groupRenameDevice(id: string, name: unknown): Promise<void> {
  await renameMember(id, name);
}

/** Forget Kg on THIS desk. Re-inviting on the others mints a new Kg, which
 *  rotates every pairwise rid — that pair is the revocation. */
export async function groupForget(): Promise<void> {
  // With Nests off there is no controller to ask, and a Forget that silently
  // did nothing would leave the roster on screen for a group this desk left.
  if (!registration || !registration.enabled()) return forgetRoster();
  await registration.target().forget();
}
