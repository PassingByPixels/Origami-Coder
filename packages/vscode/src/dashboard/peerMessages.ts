// What the shell does with a handoff from another agent session (t-kgu05m).
//
// Its own leaf because DashboardPanel.ts sat exactly ON its line cap, and the
// ratchet's remedy is extraction. The panel keeps a one-line dispatch; the two
// decisions live here.
//
// Decision 1 — it is NOT `echoUser`. That message type means "the human's turn
// started": the sidebar ring flips on it and the transcript styles it as user
// input. A peer's handoff is neither, and reusing the channel would have made
// another agent's words indistinguishable from the operator's.
//
// Decision 2 — the ARCHIVE keeps it as a `system` row. The saved transcript
// shape (DashboardPanel's SessionMessage) has no peer kind, and inventing one
// would migrate every session file on disk for a restored-view nicety. A
// readable "from -> reply address" line preserves the provenance a recall needs;
// the LIVE row is the badged one.

export interface PeerOrigin {
  from: string;
  replyTo: string;
}

/** The archive row for a received peer message. */
export function peerLogEntry(peer: PeerOrigin & { text: string }, now = Date.now()) {
  return {
    kind: 'system' as const,
    text: `Message from agent ${peer.from} (reply to ${peer.replyTo}):\n${peer.text}`,
    timestamp: now,
  };
}
