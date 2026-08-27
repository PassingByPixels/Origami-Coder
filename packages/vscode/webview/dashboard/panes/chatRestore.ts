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

import { applyToolCall, applyToolResult, type ToolCardMsg } from './chatToolMsg';

/** One entry of the host's `Session.messageLog` as it arrives on the wire. */
export interface RestoredEntry {
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error';
  text: string;
  timestamp?: number;
  tool?: { call: Record<string, unknown>; result?: Record<string, unknown> };
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
      out = applyToolCall(out, entry.tool.call, nextId());
      // applyToolCall stamps Date.now() for the sub-agent drawer's ageing; a
      // restored card must keep the time the step actually ran.
      const card = out[out.length - 1];
      if (card && entry.timestamp) card.timestamp = entry.timestamp;
      if (entry.tool.result) out = applyToolResult(out, entry.tool.result, nextId());
      continue;
    }
    const row = {
      id: nextId(),
      kind: entry.kind === 'tool' ? 'system' : entry.kind,
      label: entry.kind === 'user'
        ? 'You'
        : entry.kind === 'agent'
          ? agentName
          : entry.kind === 'tool'
            ? 'tool'
            : entry.kind,
      text: entry.text,
      timestamp: entry.timestamp,
    };
    out = [...out, row as unknown as M];
  }
  return out;
}
