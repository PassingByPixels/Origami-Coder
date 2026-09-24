// What the shell does with a handoff from another agent session, its own leaf since
// DashboardPanel.ts sat exactly on its line cap.
//
// Not `echoUser`: that message means the human's turn started, and a peer's handoff is neither.
//
// t-d94ywq: this used to archive the row as a `system` line with the rider flattened into prose
// ("Message from agent X (reply to Y):"), because a peer message only ever occurs in an
// engine-backed session, and `saveSession` skips those (the engine owns the durable log — see
// `loadedFromEngineId` in DashboardPanel.ts). So the flattened shape below never actually reached
// disk; it only ever reached `session.messageLog`, the in-memory cache `recallSession` rebuilds
// fresh on every history recall — and a recall rendered the flattened prose, not the live
// PeerMessageRow. The kept `peer` rider (`kind: 'peer'` — `sessionLog.ts` / `restoredRow.ts`) lets a
// restore rebuild the identical row.
export interface PeerOrigin {
  from: string;
  replyTo: string;
  /** Set when the sender is a FLOCK contact — another person's Origami — rather
   *  than another of this owner's sessions. Mirrors src/acpPeerMeta.ts. */
  flock?: { contact: string; thread: string; kind: string; icon?: string };
  /** Set when the sender is one of THIS chat's own sub-agents asking a
   *  question. Mirrors src/acpPeerMeta.ts. */
  subagent?: { label: string; requestID: string; sessionID: string };
}

/** The log row for a received peer message — `text` is the RAW envelope, same as the live
 *  `onPeerMessage` payload, so PeerMessageRow's own `peerBody()` strips it identically on replay. */
export function peerLogEntry(peer: PeerOrigin & { text: string }, now = Date.now()) {
  return {
    kind: 'peer' as const,
    text: peer.text,
    timestamp: now,
    peer: {
      from: peer.from,
      replyTo: peer.replyTo,
      ...(peer.flock ? { flock: peer.flock } : {}),
      ...(peer.subagent ? { subagent: peer.subagent } : {}),
    },
  };
}
