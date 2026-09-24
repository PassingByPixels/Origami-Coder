// The `_meta.origami_peer` rider: "this user turn came from another AGENT".
//
// FAIL-CLOSED is the whole rule. A peer message arrives in the same wire slot as the
// human's own turn (`user_message_chunk`), so a half-formed rider must read as NO
// rider. Validated the same way in packages/engine/src/session/peer-message.ts.
//
// WHICH kind of agent — a flock contact, or one of this chat's own sub-agents —
// is acpPeerRiders.ts beside it. This file decides only whether the message
// leaves the human transcript at all.

import { flockFromMeta, subagentFromMeta, type FlockOrigin, type SubagentOrigin } from './acpPeerRiders';

export type { FlockOrigin, SubagentOrigin } from './acpPeerRiders';

export interface PeerOrigin {
  /** The sending agent's display name. */
  from: string;
  /** The address a reply goes to — `name#sessionId`. */
  replyTo: string;
  flock?: FlockOrigin;
  subagent?: SubagentOrigin;
}

/** The provenance an update carries, or undefined for an ordinary user turn. */
export function peerFromMeta(update: unknown): PeerOrigin | undefined {
  const meta = (update as { _meta?: { origami_peer?: unknown } } | undefined)?._meta?.origami_peer;
  if (!meta || typeof meta !== 'object') return undefined;
  const peer = meta as { from?: unknown; replyTo?: unknown; flock?: unknown; subagent?: unknown };
  if (typeof peer.from !== 'string' || !peer.from || typeof peer.replyTo !== 'string' || !peer.replyTo) return undefined;
  const flock = flockFromMeta(peer.flock);
  const subagent = subagentFromMeta(peer.subagent);
  return { from: peer.from, replyTo: peer.replyTo, ...(flock ? { flock } : {}), ...(subagent ? { subagent } : {}) };
}
