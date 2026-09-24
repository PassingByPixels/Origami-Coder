// chatRestore.ts — the `restoreMessages` rebuild rule, EXTRACTED from
// ChatPane.svelte's message router so it can be asserted without a render.
//
// The rule that was WRONG: every logged entry became a text row, so a 'tool'
// entry restored as a plain `system` line. That is exactly what a RELOADED chat
// showed instead of its tool cards — the engine replays `tool_call` +
// `tool_call_update` faithfully on `session/load`, but a recalled chat's tab
// does not exist yet when those arrive, so the tab is caught up from the host's
// message log instead, and the log's tool entries came back as text.
//
// An entry that carries its tool payload (src/dashboard/sessionLog.ts) now
// rebuilds the REAL card through the same merge rules the live stream uses. An
// entry without one — an archive written before the fix — still restores as a
// text row, so old history keeps rendering exactly as it did.
//
// t-d94ywq: the same gap existed for a 'peer' entry — a collab handoff or a
// sub-agent's `send_message` reply arrives live as its own PeerMessageRow, but
// a recalled chat's log entry (src/dashboard/peerMessages.ts) carried only
// prose, so it came back as a plain system line. restoredRow.ts rebuilds the
// row (kind 'peer', PeerMessageRow's fields) the same way this file already
// does for a tool card.

import { applyToolCall, applyToolResult, type ToolCardMsg } from './chatToolMsg';
import { replayedResult } from './replayedTokens';
import { restoredRow, type RestoredRowEntry } from './restoredRow';
import { settleStreamDrop } from './streamDropNotice';

/** One entry of the host's `Session.messageLog` as it arrives on the wire. */
export interface RestoredEntry extends RestoredRowEntry {
  tool?: { call: Record<string, unknown>; result?: Record<string, unknown> };
}

/**
 * True when a restore REPLACES the rows an earlier one put on screen rather
 * than adding to them.
 *
 * The PHONE SHELL stamps it (`webview/remote/cache.ts`): a page that painted
 * its cached transcript before the socket was open gets a second, authoritative
 * restore when the desktop hydrates — and `acceptsReplayedLog` drops that one,
 * because a pane with rows takes no replay. The sidebar never sends the field.
 */
export function replacesRestored(msg: { replaces?: unknown }): boolean {
  return msg.replaces === true;
}

/** Append a restored log to `messages`. `nextId` is the pane's own id counter
 *  (a card may consume two: the call, and an unmatched result's fallback row). */
export function restoreLog<M extends ToolCardMsg>(
  messages: M[],
  entries: readonly RestoredEntry[],
  nextId: () => number,
  agentName: string,
): M[] {
  let out = messages;
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.tool) {
      out = settleStreamDrop(out); // t-sj3fvo: a tool call recovers the card too.
      out = applyToolCall(out, entry.tool.call, nextId());
      // applyToolCall stamps Date.now() for the sub-agent drawer's ageing; a
      // restored card must keep the time the step actually ran.
      const card = out[out.length - 1];
      if (card && entry.timestamp) card.timestamp = entry.timestamp;
      // t-q910fo: the stored result, with a never-billed `0 / 0` token rider
      // dropped. REPLAY ONLY — a live update is left exactly as it arrives.
      if (entry.tool.result) out = applyToolResult(out, replayedResult(entry.tool.result), nextId());
      continue;
    }
    // A restored 'agent' turn with prose, or any 'thought' turn, closes the
    // card above it, the SAME rule the live pane applies (t-q90gj9, t-sj3fvo).
    if ((entry.kind === 'agent' && entry.text.trim()) || entry.kind === 'thought') out = settleStreamDrop(out);
    out = [...out, { id: nextId(), ...restoredRow(entry, agentName) } as unknown as M];
  }
  return out;
}
