// THE DEVICE GROUP, as one object: the secret, the roster, and one live link
// per other desk.
//
// It owns no protocol of its own. deviceGroup.ts holds Kg, groupCrypto.ts turns
// Kg and two ids into a rid and a key, groupLink.ts is one socket's worth of
// sealing and presence, groupWire.ts is the sentences they exchange,
// groupHandshake.ts is the join with its Accept step (t-sj32zl), and
// groupMembers.ts is the roster the pane draws. This file is the wiring and the
// one rule that needs a whole file to state: A LINK PER PEER, never a link per
// group, because the relay has two roles per rid and a group has more desks
// than that.
//
// THE LEASE IS PER LINK. One VS Code window may hold a pairwise rid at a time
// (the relay evicts the loser with 4001), and the lease record is already keyed
// by rid — so asking `claim(pairRid)` before each socket gives per-DEVICE
// ownership for free, where the phone lane had one lease for one pairing.

import type { RemoteKey } from './crypto';
import { DeviceGroup } from './deviceGroup';
import { GroupLink } from './groupLink';
import { derivePairKey, derivePairRid, pairRole } from './groupCrypto';
import type { Role } from './frame';
import { groupHelloMessage, readGroupHello, readGroupPeer } from './groupWire';
import { GroupRosterStore, groupRosterStore } from './groupMembers';
import type { SecretStore } from './pairing';
import type { DeskOs } from './deskOs';
import type { TransportDeps } from './transport';
import { groupDevices, type GroupSnapshot } from './groupSnapshot';
import { GROUP_ROSTER, groupRosterMessage, mergeRoster } from './groupGossip';
import { JoinHandshake } from './groupHandshake';

export type { GroupDeviceView, GroupSnapshot } from './groupSnapshot';

export interface GroupControllerOptions {
  config: () => { enabled: boolean; relayUrl: string };
  secrets: SecretStore;
  deps: TransportDeps;
  /** This machine's name in the roster others see. The workspace name. */
  deviceName: string;
  /** The owner lease, asked with the PAIRWISE rid before any socket opens. */
  claim?: (rid: string) => Promise<boolean>;
  onStatus?: (text: string) => void;
  os?: DeskOs; // announced in every hello (t-s9jr6u)
  /** A desk joined, said hello or dropped off: the pane pushes a new snapshot. */
  onChange?: () => void;
  /** Any peer message that is not a hello, from a peer that said hello (the nest verbs). */
  onPeerMessage?: (peerId: string, msg: Record<string, unknown>) => void;
  now?: () => number;
  /** The machine's roster. Injected so two desks can be driven in one test
   *  process; production passes nothing and gets the singleton. */
  roster?: GroupRosterStore;
}

export class GroupController {
  private readonly group: DeviceGroup;
  private readonly links = new Map<string, GroupLink>();
  private readonly online = new Set<string>();
  private readonly handshake: JoinHandshake;

  private readonly roster: GroupRosterStore;

  constructor(private readonly opts: GroupControllerOptions) {
    this.group = new DeviceGroup(opts.secrets);
    this.roster = opts.roster ?? groupRosterStore;
    this.handshake = new JoinHandshake({
      group: this.group, roster: this.roster, deps: opts.deps, deviceName: opts.deviceName, os: opts.os,
      now: () => this.now,
      link: (rid, key, role, onMessage) => this.link(rid, key, role, onMessage),
      openPair: (id) => this.openPair(id),
      sendRoster: (except) => this.sendRoster(except),
      onRoster: (from, msg) => this.onRoster(from, msg),
      changed: () => this.opts.onChange?.(),
    });
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  public get deviceId(): string | null {
    return this.group.deviceId;
  }

  public snapshot(): GroupSnapshot {
    const self = this.group.deviceId;
    return {
      active: this.group.current !== null,
      deviceId: self,
      devices: groupDevices(this.roster.read(), self, this.online, this.opts.os),
      inviteKey: this.handshake.key,
      inviteExpiresAt: this.handshake.expiresAt,
      joinCheck: this.handshake.check,
      joinNotice: this.handshake.notice,
    };
  }

  /** Seal one message to one peer's link (t-sc093o, the nest verbs). Dropped
   *  while the peer is away, as every link send is. */
  public send(peerId: string, msg: Record<string, unknown>): void {
    this.links.get(peerId)?.send(msg);
  }

  /** Bring a stored group back up: one link per roster member. */
  public async restore(): Promise<void> {
    if (!this.opts.config().enabled) return;
    const identity = await this.group.load();
    if (!identity) return;
    await this.roster.remember(identity.deviceId, this.opts.deviceName, this.now, this.opts.os);
    for (const member of this.roster.read().members) {
      if (member.id !== identity.deviceId) await this.openPair(member.id);
    }
  }

  /** Show an invitation. Mints the group on the first desk that asks. The key
   *  carries a one-time secret, never Kg (t-sj32zl, groupHandshake.ts). */
  public async invite(): Promise<{ key: string; expiresAt: number }> {
    const identity = (await this.group.load()) ?? (await this.group.mint());
    await this.roster.remember(identity.deviceId, this.opts.deviceName, this.now, this.opts.os);
    return this.handshake.invite(identity.deviceId);
  }

  /** Take a scanned or pasted key and ask to join. Kg and the roster arrive in
   *  the welcome, after the inviting desk's owner clicks Accept. */
  public join(keyText: unknown): Promise<void> {
    return this.handshake.join(keyText);
  }

  /** The inviting desk's owner answers the desk that asked to join. */
  public answerJoin(accept: boolean): Promise<void> {
    return this.handshake.answer(accept);
  }

  /** One peer's link. Idempotent — restore() and a welcome can both ask. */
  private async openPair(peerId: string): Promise<void> {
    const identity = this.group.current;
    const self = identity?.deviceId;
    if (!identity || !self || peerId === self || this.links.has(peerId)) return;
    const rid = await derivePairRid(identity.kg, self, peerId);
    if (this.opts.claim && !(await this.opts.claim(rid))) {
      this.opts.onStatus?.('group: this device is linked in another window');
      return;
    }
    const key = await derivePairKey(identity.kg, self, peerId);
    if (this.links.has(peerId)) return; // a welcome and a gossip merge can ask at once
    const link = this.link(rid, key, pairRole(self, peerId), (msg) => void this.onPeerMessage(peerId, msg), peerId);
    this.links.set(peerId, link);
    link.start();
  }

  private link(
    rid: string,
    key: RemoteKey,
    role: Role,
    onMessage: (msg: Record<string, unknown>) => void,
    peerId?: string,
  ): GroupLink {
    return new GroupLink({
      relayUrl: this.opts.config().relayUrl,
      rid,
      key,
      role,
      deps: this.opts.deps,
      onMessage,
      onPresence: (presence, edge) => {
        if (!peerId) return;
        // ARRIVED is the edge that says something new: the peer's socket is up,
        // so say who we are. ABSENT is the ring-free half of presence.
        if (edge !== null) this.sayHello(peerId);
        if (presence === 'absent' && this.online.delete(peerId)) {
          void this.roster.seen(peerId, this.now).then(() => this.opts.onChange?.());
        }
      },
      onStatus: (text) => this.opts.onStatus?.(text),
    });
  }

  private sayHello(peerId: string): void {
    const self = this.group.deviceId;
    if (!self) return;
    this.links.get(peerId)?.send(groupHelloMessage(self, this.opts.deviceName, this.roster.read().motherBase, this.now, this.opts.os));
    this.links.get(peerId)?.send(groupRosterMessage(self, this.roster.read())); // each reconnect re-syncs the roster
  }

  /** This desk's roster to every linked desk but `except`; one that is away gets it after its next hello. */
  private sendRoster(except?: string): void {
    const self = this.group.deviceId;
    if (!self) return;
    for (const [id, link] of this.links) if (id !== except) link.send(groupRosterMessage(self, this.roster.read()));
  }

  /** A peer's roster (groupGossip.ts has the rule). Sent on only when it changed ours. */
  private async onRoster(from: string, raw: unknown): Promise<void> {
    const self = this.group.deviceId;
    if (!self) return;
    const merge = mergeRoster(this.roster.read(), raw, self, this.now);
    if (!merge.changed) return;
    await this.roster.save(merge.next);
    for (const id of merge.removed) this.dropLink(id);
    for (const id of merge.added) await this.openPair(id);
    this.sendRoster(from);
    this.opts.onChange?.();
  }

  /** A hello is the only proof a peer is REALLY there: the relay's presence
   *  says a socket exists, this says it holds Kg. */
  private async onPeerMessage(peerId: string, msg: Record<string, unknown>): Promise<void> {
    const hello = readGroupHello(msg);
    if (!hello) {
      if (msg['type'] === GROUP_ROSTER) return readGroupPeer(msg)?.id === peerId ? this.onRoster(peerId, msg) : undefined;
      if (this.online.has(peerId)) this.opts.onPeerMessage?.(peerId, msg);
      return;
    }
    // A removed desk's hello must not re-admit it: only an Accept does (t-t8khdv).
    if (hello.id !== peerId || this.roster.read().removed.includes(peerId)) return;
    this.online.add(peerId);
    await this.roster.remember(peerId, hello.name, this.now, hello.os);
    this.opts.onChange?.();
  }

  /** Mark the home device. Gossiped to every desk; the later mark wins. */
  public async markMotherBase(id: string | null): Promise<void> {
    await this.roster.setMotherBase(id, this.now);
    for (const peerId of this.links.keys()) this.sayHello(peerId);
  }

  /** Drop one desk from the roster and close its link. Kg is untouched — see
   *  `forget()` for the rotation that actually locks a device out. */
  public async removeDevice(id: string): Promise<void> {
    this.dropLink(id);
    await this.roster.forget(id, this.now);
    this.sendRoster(); // the removal reaches every desk (t-sfyata)
  }

  private dropLink(id: string): void {
    this.links.get(id)?.stop('removed from the group');
    this.links.delete(id);
    this.online.delete(id);
  }

  /** Forget the group. Every pairwise rid is derived from Kg, so a new group
   *  minted after this rotates all of them at once and a device that kept the
   *  old Kg is on rendezvous ids nobody connects to. */
  public async forget(): Promise<void> {
    this.dispose();
    await this.group.forget();
    await this.roster.clear();
  }

  public closeInvite(): void {
    this.handshake.close();
  }

  public dispose(): void {
    this.closeInvite();
    for (const link of this.links.values()) link.stop('window closed');
    this.links.clear();
    this.online.clear();
  }
}
