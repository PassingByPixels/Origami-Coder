// rewindSlice.ts — WHICH messages a "Rewind to here" drops, EXTRACTED from
// ChatPane.svelte's rewindTo() so the walk-back can be asserted without a
// render. The pane was sitting at 2698/2700 and the optimistic user echo
// (userEcho.ts) had no room beside it.
//
// The rule worth keeping honest: the engine's `revert` resolves to the last
// USER message, so the transcript has to be trimmed from the user message that
// OPENED the named agent turn — not from the agent message the button sits on.
// Trimming from the agent message would leave the user's question stranded
// above a turn the engine has already deleted.

/** The two fields this rule reads on a transcript row, and nothing else. */
export interface RewindMessage {
  kind: string;
  engineMsgId?: string;
}

/**
 * Split `messages` for a rewind to `engineMsgId`: what stays, and what is
 * stashed for Undo. `null` when there is nothing to drop — an id no agent row
 * carries (a stale button on a re-rendered transcript) must be a no-op, never
 * an empty-slice wipe.
 */
export function rewindSlice<M extends RewindMessage>(
  messages: readonly M[],
  engineMsgId: string,
): { keep: M[]; removed: M[] } | null {
  const idx = messages.findIndex((m) => m.engineMsgId === engineMsgId && m.kind === 'agent');
  if (idx < 0) return null;
  let start = idx;
  while (start > 0 && messages[start].kind !== 'user') start--;
  const removed = messages.slice(start);
  if (removed.length === 0) return null;
  return { keep: messages.slice(0, start), removed };
}
