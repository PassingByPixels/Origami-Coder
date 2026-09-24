// What two desks in a group actually SAY to each other. Nothing here times
// out on its own: the join rendezvous closes with the invite window.
//
//   group/join     joiner  -> inviter, on the join rendezvous (v2, t-sj32zl:
//                  derived from the invite's one-time secret). "I am <id>,
//                  <desk name>", plus an ephemeral public key (`pub`). The
//                  inviter then WAITS for its owner.
//   group/welcome  inviter -> joiner, same rid, ONLY after the owner clicks
//                  Accept. The rest of the roster, so a third desk does not
//                  have to be invited by all the others, plus Kg sealed to
//                  the joiner's key (`pub` + `box`, groupWelcomeSeal.ts).
//   group/declined inviter -> joiner, same rid, on Decline. No secret in it.
//                  The handshake itself is groupHandshake.ts.
//   group/hello    either  -> either, on a PAIRWISE rid, once per socket. It
//                  is presence: the relay's peer:present says a socket exists,
//                  this says WHO is on it and that they hold Kg (the frame
//                  opened at all, which nothing without Kg can make happen).
//
// RING-FREE: absence is the relay's peer:absent control frame, never a
// heartbeat message. A desk that is asleep costs the group nothing.

import { cleanGroupName } from './groupMembers';
import { isDeviceId } from './groupCrypto';
import { readDeskOs, type DeskOs } from './deskOs';

export const GROUP_JOIN = 'group/join';
export const GROUP_WELCOME = 'group/welcome';
export const GROUP_HELLO = 'group/hello';

export interface GroupPeerInfo {
  id: string;
  name: string;
}

export interface GroupHello extends GroupPeerInfo {
  /** The sender's OWN view of which device is the home one. Carried so a later
   *  lane can show a disagreement; the pane draws the LOCAL setting, because a
   *  device that could claim the flag could claim the state that goes with it. */
  motherBase: string | null;
  at: number;
  /** The sender's OS family (t-s9jr6u). Absent from an older desk: ''. */
  os: DeskOs;
}

export function groupJoinMessage(from: string, name: string): Record<string, unknown> {
  return { type: GROUP_JOIN, from, name: cleanGroupName(name) };
}

export function groupWelcomeMessage(from: string, name: string, peers: GroupPeerInfo[]): Record<string, unknown> {
  return {
    type: GROUP_WELCOME,
    from,
    name: cleanGroupName(name),
    peers: peers.map((p) => ({ id: p.id, name: cleanGroupName(p.name) })),
  };
}

export function groupHelloMessage(
  from: string,
  name: string,
  motherBase: string | null,
  at: number,
  os: DeskOs = '',
): Record<string, unknown> {
  return { type: GROUP_HELLO, from, name: cleanGroupName(name), motherBase, at, ...(os ? { os } : {}) };
}

/** Anything off the wire is UNTRUSTED: a message whose `from` is not a device
 *  id is dropped rather than repaired, or a peer could name itself a rid. */
export function readGroupPeer(msg: unknown): GroupPeerInfo | null {
  const m = msg as { from?: unknown; name?: unknown } | null;
  if (!m || !isDeviceId(m.from)) return null;
  return { id: m.from, name: cleanGroupName(m.name) };
}

export function readGroupHello(msg: unknown): GroupHello | null {
  const peer = readGroupPeer(msg);
  if (!peer || (msg as { type?: unknown }).type !== GROUP_HELLO) return null;
  const m = msg as { motherBase?: unknown; at?: unknown; os?: unknown };
  return {
    ...peer,
    motherBase: isDeviceId(m.motherBase) ? m.motherBase : null,
    at: typeof m.at === 'number' && m.at > 0 ? m.at : 0,
    os: readDeskOs(m.os),
  };
}

/** The roster a welcome carries, minus anything malformed and minus the
 *  receiver itself — a desk is never its own peer. */
export function readGroupWelcome(msg: unknown, self: string): GroupPeerInfo[] {
  if ((msg as { type?: unknown } | null)?.type !== GROUP_WELCOME) return [];
  const raw = (msg as { peers?: unknown }).peers;
  const out: GroupPeerInfo[] = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const p = value as { id?: unknown; name?: unknown } | null;
    if (!p || !isDeviceId(p.id) || p.id === self) continue;
    out.push({ id: p.id, name: cleanGroupName(p.name) });
  }
  const from = readGroupPeer(msg);
  if (from && from.id !== self && !out.some((p) => p.id === from.id)) out.unshift(from);
  return out;
}
