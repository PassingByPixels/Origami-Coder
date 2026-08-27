// The `_meta.origami_peer` rider: "this user turn came from another AGENT".
//
// Its own leaf, beside acpTaskMeta.ts and questionBatch.ts, which decode the
// other riders acpClient.ts routes on — that file sat exactly on its line cap,
// and the ratchet's remedy is a module, not a bigger number.
//
// FAIL-CLOSED is the whole rule here. A peer message arrives in the same wire
// slot as the human's own turn (`user_message_chunk`), so a half-formed rider
// must read as NO rider: rendering the operator's own words under an invented
// sender's name is worse than losing a badge. The engine writes the key in
// packages/engine/src/session/peer-message.ts and validates it the same way.

export interface PeerOrigin {
  /** The sending agent's display name. */
  from: string;
  /** The address a reply goes to — `name#sessionId`. */
  replyTo: string;
}

/** The provenance an update carries, or undefined for an ordinary user turn. */
export function peerFromMeta(update: unknown): PeerOrigin | undefined {
  const meta = (update as { _meta?: { origami_peer?: unknown } } | undefined)?._meta?.origami_peer;
  if (!meta || typeof meta !== 'object') return undefined;
  const peer = meta as { from?: unknown; replyTo?: unknown };
  if (typeof peer.from !== 'string' || !peer.from) return undefined;
  if (typeof peer.replyTo !== 'string' || !peer.replyTo) return undefined;
  return { from: peer.from, replyTo: peer.replyTo };
}
