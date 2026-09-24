// restoredRow.ts — the plain-row shape for one restored log entry, split out of
// chatRestore.ts's restoreLog so the 'peer' branch fits under that file's cap.
// A 'tool' entry with a payload never reaches here — chatRestore.ts rebuilds it
// through applyToolCall/applyToolResult, the SAME merge rules the live stream
// uses.
//
// Fail-closed for 'peer' like acpPeerMeta.ts: a rider with no `from`/`replyTo`
// (or none at all — an archive written before t-d94ywq) restores as a plain
// system row rather than inventing a sender.

import { asStreamDropNotice } from './streamDropNotice';

export interface PeerRider {
  from: string;
  replyTo: string;
  /** Mirrors src/acpPeerMeta.ts FlockOrigin. */
  flock?: { contact: string; thread: string; kind: string; icon?: string };
  /** Mirrors src/acpPeerMeta.ts SubagentOrigin. */
  subagent?: { label: string; requestID: string; sessionID: string };
}

export interface RestoredRowEntry {
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error' | 'peer' | 'thought' | 'streamDrop';
  text: string;
  timestamp?: number;
  peer?: PeerRider;
  /** t-q90gj9: the dropped-stream notice, so a reloaded window restores the
   *  alert card rather than an empty system line. Same fail-closed rule as
   *  'peer': an entry with no readable rider is not restored as a card. */
  streamDrop?: unknown;
  /** t-ucnp7t: an 'agent' entry from an older page carries its engine message id: the rewind anchor. */
  messageId?: string;
}

export function restoredRow(entry: RestoredRowEntry, agentName: string) {
  if (entry.kind === 'peer' && entry.peer?.from && entry.peer?.replyTo) {
    return {
      kind: 'peer' as const,
      label: entry.peer.from,
      text: entry.text,
      timestamp: entry.timestamp,
      peerReplyTo: entry.peer.replyTo,
      peerFlock: entry.peer.flock,
      peerSubagent: entry.peer.subagent,
    };
  }
  // t-q90gj9: the dropped-stream card, rebuilt from its rider. The entry's
  // `text` is empty by construction — a notice has no prose — so without this
  // it would restore as a blank system row.
  if (entry.kind === 'streamDrop') {
    const notice = asStreamDropNotice(entry.streamDrop);
    if (notice) {
      // `recovered` is not restored here: it is not a property of the notice but
      // of what came AFTER it, and only restoreLog sees the following entries.
      return { kind: 'streamDrop' as const, label: 'System', text: '', timestamp: entry.timestamp,
        streamDrop: { notice } };
    }
  }
  // t-gvz8t0: a 'thought' row passes through as itself — ChatTranscript draws it
  // with ThoughtPill, the same block the main chat uses for its own reasoning.
  // Folding it into 'system' (the fallback below) would print a child's thought
  // as flat transcript text, which is the one thing it must never look like.
  return {
    // 'streamDrop' reaches here only when its rider was unreadable (above);
    // falling through as itself would leave an invisible row, because the
    // transcript draws that kind only when the notice is on it.
    kind: entry.kind === 'tool' || entry.kind === 'peer' || entry.kind === 'streamDrop' ? 'system' : entry.kind,
    label: entry.kind === 'user'
      ? 'You'
      : entry.kind === 'agent'
        ? agentName
        : entry.kind === 'tool'
          ? 'tool'
          : entry.kind === 'peer'
            ? 'system'
            : entry.kind,
    text: entry.text,
    timestamp: entry.timestamp,
    ...(entry.kind === 'agent' && entry.messageId ? { engineMsgId: entry.messageId } : {}),
  };
}
