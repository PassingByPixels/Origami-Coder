// THE JOIN HANDSHAKE (t-sj32zl): how a new desk gets Kg, and only with the
// owner's consent. Extracted from groupController.ts, which sat at its cap.
//
//   1. Invite: the inviter mints a ONE-TIME secret (16 random bytes, memory
//      only) and shows `origami-group-v2.<secret>.<inviter id>`. It waits on
//      the join rendezvous derived from that secret (groupCrypto.ts).
//   2. Join: the joiner reads the key, mints its id-to-be and an ephemeral
//      key pair, and sends group/join (id, desk name, public key) sealed
//      under the join key. It stores NOTHING yet: the key holds no Kg.
//   3. Both desks show a six-digit match code from the secret, both ids and
//      the joiner's public key. The inviter's pane shows "<desk> wants to
//      join, code 123 456" with Accept and Decline.
//   4. Accept: the welcome carries the roster and Kg sealed TO the joiner's
//      key (groupWelcomeSeal.ts). Decline: group/declined, no secret in it.
//      Either way, and on expiry or a window reload, the invite is gone: the
//      secret lived only in this object.
//
// A key is single use: one request per invite, and a second invite mints a
// new secret, so it opens a new rendezvous.

import { b64urlEncode, type RemoteKey } from './crypto';
import { groupKeyString, type DeviceGroup } from './deviceGroup';
import type { DeskOs } from './deskOs';
import { ROLE_DESKTOP, ROLE_PHONE, type Role } from './frame';
import { deriveJoinKey, deriveJoinRid, deriveMatchCode, generateInviteSecret } from './groupCrypto';
import { rosterFields } from './groupGossip';
import { GroupInvite } from './groupInvite';
import type { GroupLink } from './groupLink';
import { cleanGroupName, type GroupRosterStore } from './groupMembers';
import { ephemeralKeys, openKg, readJoinPub, sealKg, type EphemeralKeys } from './groupWelcomeSeal';
import { GROUP_JOIN, GROUP_WELCOME, groupJoinMessage, groupWelcomeMessage, readGroupPeer, readGroupWelcome } from './groupWire';
import type { TransportDeps } from './transport';

export const GROUP_DECLINED = 'group/declined';

/** What the pane draws while a join is in flight. `side` says which desk this is. */
export interface JoinCheck {
  side: 'inviter' | 'joiner';
  /** The JOINING desk's name, on both sides: the owner checks it matches. */
  name: string;
  code: string;
}

export interface HandshakeHost {
  group: DeviceGroup;
  roster: GroupRosterStore;
  deps: TransportDeps;
  deviceName: string;
  os?: DeskOs;
  now(): number;
  link(rid: string, key: RemoteKey, role: Role, onMessage: (msg: Record<string, unknown>) => void): GroupLink;
  openPair(peerId: string): Promise<void>;
  sendRoster(except?: string): void;
  onRoster(from: string, msg: Record<string, unknown>): Promise<void>;
  changed(): void;
}

interface Asking { id: string; name: string; code: string; pub: Uint8Array }

export class JoinHandshake {
  private readonly window: GroupInvite;
  /** The invite's one-time secret. Never stored, never sent. */
  private secret: Uint8Array | null = null;
  private inviterId: string | null = null;
  /** Joiner side: this desk's ephemeral pair; its id is `asking.id`. */
  private mine: EphemeralKeys | null = null;
  /** Inviter side: the desk that asked. Joiner side: this desk. */
  private asking: Asking | null = null;
  /** One line for the pane after a join ended without a welcome. */
  public notice: string | null = null;

  constructor(private readonly host: HandshakeHost) {
    this.window = new GroupInvite(host.deps, () => this.expired());
  }

  public get key(): string | null {
    return this.window.key;
  }

  public get expiresAt(): number | null {
    return this.window.expiresAt;
  }

  public get check(): JoinCheck | null {
    if (!this.asking) return null;
    return { side: this.mine ? 'joiner' : 'inviter', name: this.asking.name, code: this.asking.code };
  }

  /** Show a NEW invitation: any older one closes first, and its secret dies. */
  public async invite(inviterId: string): Promise<{ key: string; expiresAt: number }> {
    this.close();
    const secret = generateInviteSecret();
    const key = groupKeyString(secret, inviterId);
    const rid = await deriveJoinRid(secret, inviterId);
    const link = this.host.link(rid, await deriveJoinKey(secret, inviterId), ROLE_DESKTOP, (m) => void this.onJoin(m));
    link.start();
    this.window.open(link, key, this.host.now());
    this.secret = secret;
    this.inviterId = inviterId;
    return { key, expiresAt: this.window.expiresAt! };
  }

  /** Take a pasted key: announce this desk on the invite's rendezvous and wait. */
  public async join(keyText: unknown): Promise<void> {
    const { secret, inviterId, deviceId } = await this.host.group.prepareJoin(keyText);
    this.close();
    const mine = await ephemeralKeys();
    const name = cleanGroupName(this.host.deviceName);
    const code = await deriveMatchCode(secret, inviterId, deviceId, mine.pub);
    const rid = await deriveJoinRid(secret, inviterId);
    const link = this.host.link(rid, await deriveJoinKey(secret, inviterId), ROLE_PHONE, (m) => void this.onReply(m));
    link.start();
    this.window.open(link, null, this.host.now());
    this.secret = secret;
    this.inviterId = inviterId;
    this.mine = mine;
    this.asking = { id: deviceId, name, code, pub: mine.pub };
    void link.send({ ...groupJoinMessage(deviceId, name), pub: b64urlEncode(mine.pub) });
  }

  /** Inviter side: a desk asked. ONE request per invite; it waits for the owner. */
  private async onJoin(msg: Record<string, unknown>): Promise<void> {
    const secret = this.secret;
    const self = this.inviterId;
    const peer = readGroupPeer(msg);
    const pub = readJoinPub(msg);
    if (msg['type'] !== GROUP_JOIN || !secret || !self || !this.window.key || this.asking) return;
    if (!peer || !pub || peer.id === self) return;
    const code = await deriveMatchCode(secret, self, peer.id, pub);
    if (this.secret !== secret || this.asking) return; // closed, or another asked, meanwhile
    this.asking = { id: peer.id, name: peer.name, code, pub };
    this.host.changed();
  }

  /** Inviter side: the owner's answer. Accept sends Kg; Decline sends no secret. */
  public async answer(accept: boolean): Promise<void> {
    const { asking, secret } = this;
    const link = this.window.link;
    const identity = this.host.group.current;
    if (!asking || !secret || !link || !this.window.key || !identity) throw new Error('origami group: no desk is waiting to join');
    if (!accept) {
      await link.send({ type: GROUP_DECLINED, from: identity.deviceId });
      this.close();
      this.host.changed();
      return;
    }
    const { roster, now } = this.host;
    await roster.remember(asking.id, asking.name, now());
    const all = roster.read();
    const known = all.members.filter((m) => m.id !== asking.id);
    const sealed = await sealKg(identity.kg, asking.pub, asking.id, secret);
    await link.send({ ...groupWelcomeMessage(identity.deviceId, this.host.deviceName, known), ...rosterFields(all), ...sealed });
    this.close(); // single use: the rendezvous and its secret end here
    await this.host.openPair(asking.id);
    this.host.sendRoster(asking.id); // the rest of the group learns of the new desk (t-sfyata)
    this.host.changed();
  }

  /** Joiner side: the inviter's answer. Only a welcome FROM the inviter that opens counts. */
  private async onReply(msg: Record<string, unknown>): Promise<void> {
    const { asking, mine, secret } = this;
    const from = readGroupPeer(msg);
    if (!asking || !mine || !secret || !from || from.id !== this.inviterId) return;
    if (msg['type'] === GROUP_DECLINED) return this.end('The other desk declined. Ask for a new invite.');
    if (msg['type'] !== GROUP_WELCOME) return;
    const kg = await openKg(msg, mine, asking.id, secret);
    if (!kg || this.asking !== asking) return;
    this.close();
    const self = asking.id;
    const { roster, now } = this.host;
    await this.host.group.adopt(kg, self);
    await roster.clear();
    await roster.remember(self, this.host.deviceName, now(), this.host.os);
    for (const peer of readGroupWelcome(msg, self)) {
      await roster.remember(peer.id, peer.name, now());
      await this.host.openPair(peer.id);
    }
    await this.host.onRoster(from.id, msg); // removals and the mother base ride the welcome too
    this.host.changed();
  }

  private expired(): void {
    this.end(this.mine ? 'No answer in 10 minutes. Ask for a new invite.' : 'The invite ran out. Make a new one.');
  }

  private end(notice: string): void {
    this.close();
    this.notice = notice;
    this.host.changed();
  }

  /** Close the invite or the wait. The secret and the ephemeral key go with it. */
  public close(): void {
    this.window.close();
    this.secret = null;
    this.inviterId = null;
    this.mine = null;
    this.asking = null;
    this.notice = null;
  }
}
