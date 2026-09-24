// The device group's ROSTER, and the one flag the owner sets by hand.
//
// Which desks are in the group is not a secret — the secret is Kg, and that
// lives in the keychain (deviceGroup.ts). So the roster lives in globalState,
// beside the phone's device names, and survives a window that never opened a
// socket: the pane must list the group with Remote switched off.
//
// MOTHER BASE is the owner's word for the home device — the one desk that keeps
// every session (design note section 4). It is ONE device id per group, set
// here and nowhere else. It is deliberately not negotiated: a machine that
// claimed to be the home device would be a machine that could claim to hold
// state it does not have.
//
// The roster is an OBJECT with a module-level singleton in front of it, not a
// module-level store like deviceNames.ts. One machine has one roster, so the
// singleton is what the pane and activation use; the object is what lets a test
// put TWO desks in one process and have them disagree, which is the only way to
// test a group without two machines.

import { isDeviceId } from './groupCrypto';
import { readDeskOs, type DeskOs } from './deskOs';
import { parseGroupRoster } from './groupRosterRecord';
import { admitMember, tombstoneMember } from './groupMembership';

/** The `vscode.Memento` surface this needs, structurally. */
export interface GroupMemberStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const GROUP_MEMBERS_KEY = 'origami.group.members';

/** A name is a LABEL, the same rule the phone's name follows. */
export const GROUP_NAME_MAX = 40;

export interface GroupMember {
  id: string;
  /** What the OWNER called this desk, or '' — a desk sends its workspace name
   *  in its hello, and that is what fills this in when nobody has renamed it. */
  name: string;
  addedAt: number;
  os: DeskOs; // announced in its hello; '' before the first one
  /** When this desk last said hello or dropped off the relay. 0 = never seen. */
  lastSeen: number;
  /** t-t8khdv: the admission's stamp, gossiped; the rule is in groupMembership.ts. */
  admittedAt?: number;
}

export interface GroupRoster {
  members: GroupMember[];
  /** The device id the owner marked as the home device, or null. */
  motherBase: string | null;
  /** When the flag last moved, on the desk that moved it: the later one wins (t-sfyata). */
  motherBaseAt: number;
  /** Desks removed from the group. A stale roster cannot re-add one; a NEWER
   *  admission of the same id can (t-t8khdv, groupMembership.ts). */
  removed: string[];
  /** Each tombstone's stamp; a missing one is 0, the oldest. */
  removedAt?: Record<string, number>;
}

export function cleanGroupName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX) : '';
}

export class GroupRosterStore {
  constructor(private store: GroupMemberStore | null = null) {}

  public register(next: GroupMemberStore | null): void {
    this.store = next;
  }

  /** The record's reader lives in groupRosterRecord.ts. */
  public read(): GroupRoster {
    return parseGroupRoster(this.store?.get<unknown>(GROUP_MEMBERS_KEY, undefined));
  }

  /** Public for the gossip merge (groupGossip.ts), which builds a whole roster. */
  public async save(next: GroupRoster): Promise<void> {
    await this.store?.update(GROUP_MEMBERS_KEY, next);
  }

  /** Add a desk, or refresh the name it announced. Idempotent: a desk that
   *  reconnects must not appear twice, and `addedAt` is when it FIRST joined.
   *  Adding a removed desk re-admits it (the handshake's Accept comes here). */
  public async remember(id: string, name: unknown, at: number, os: unknown = ''): Promise<void> {
    if (!this.store || !isDeviceId(id)) return;
    const next = this.read();
    const clean = cleanGroupName(name);
    const known = readDeskOs(os);
    const found = next.members.find((m) => m.id === id);
    // An empty announcement never erases a name the owner typed, nor a known OS.
    if (found) {
      if (clean) found.name = clean;
      if (known) found.os = known;
      found.lastSeen = at;
    } else {
      admitMember(next, { id, name: clean, addedAt: at, os: known, lastSeen: at }, at);
    }
    await this.save(next);
  }

  /** A desk dropped off the relay: keep the time, so the card can say "last seen". */
  public async seen(id: string, at: number): Promise<void> {
    if (!this.store) return;
    const next = this.read();
    const found = next.members.find((m) => m.id === id);
    if (!found) return;
    found.lastSeen = at;
    await this.save(next);
  }

  /** Rename a desk. An empty name falls back to the id prefix in the pane. */
  public async rename(id: string, name: unknown): Promise<void> {
    if (!this.store || !isDeviceId(id)) return;
    const next = this.read();
    const found = next.members.find((m) => m.id === id);
    if (!found) return;
    found.name = cleanGroupName(name);
    await this.save(next);
  }

  /** Drop one desk. Kg is NOT rotated here: rotating is minting a new group
   *  (`DeviceGroup.mint`), and forgetting a dead laptop and re-keying three
   *  machines are not the same act. */
  public async forget(id: string, at = Date.now()): Promise<void> {
    if (!this.store) return;
    const next = this.read();
    // The row goes, stamped past its admission. A row always holds a device id (the reader).
    if (isDeviceId(id)) tombstoneMember(next, id, at);
    if (next.motherBase === id) next.motherBase = null;
    await this.save(next);
  }

  /** Mark the home device. ONE at a time; null clears it. */
  public async setMotherBase(id: string | null, at = 0): Promise<void> {
    if (!this.store) return;
    const next = this.read();
    next.motherBase = isDeviceId(id) ? id : null;
    // Later than anything this desk has seen, so a slow clock still moves it.
    next.motherBaseAt = Math.max(at, next.motherBaseAt + 1);
    await this.save(next);
  }

  /** The whole roster goes when the group does — the ids derive nothing without Kg. */
  public async clear(): Promise<void> {
    if (!this.store) return;
    await this.save({ members: [], motherBase: null, motherBaseAt: 0, removed: [], removedAt: {} });
  }
}

/** THE machine's roster. Registered by activateGroup.ts, read by the pane. */
export const groupRosterStore = new GroupRosterStore();

export function registerGroupMembers(next: GroupMemberStore | null): void {
  groupRosterStore.register(next);
}

/** Test hook: back to a window that never activated Remote. */
export function resetGroupMembers(): void {
  groupRosterStore.register(null);
}

export function roster(): GroupRoster {
  return groupRosterStore.read();
}

export function motherBase(): string | null {
  return groupRosterStore.read().motherBase;
}

export const rememberMember = (id: string, name: unknown, at = Date.now()): Promise<void> =>
  groupRosterStore.remember(id, name, at);
export const renameMember = (id: string, name: unknown): Promise<void> => groupRosterStore.rename(id, name);
export const forgetMember = (id: string): Promise<void> => groupRosterStore.forget(id);
export const setMotherBase = (id: string | null): Promise<void> => groupRosterStore.setMotherBase(id);
export const forgetRoster = (): Promise<void> => groupRosterStore.clear();
