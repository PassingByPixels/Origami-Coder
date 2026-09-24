// chatEmptyGate.ts — should the chat pane draw the empty-state crane?
//
// THE BUG. The gate asked whether a `user` or `agent` row existed. A session
// whose transcript holds only a tool card (a restored `read`), or only a
// thought, therefore counted as empty, and the crane plus its rotating tips
// drew ON TOP of real content — the porting index's row 16.
//
// The honest question is whether the transcript has anything a reader would
// call content. Only the kinds below are scaffolding: the opening `system`
// line the pane writes itself, and the bookkeeping rows a turn leaves behind.
// Everything else — a message, a tool call, a thought, an error, a peer's
// handoff, a dropped-stream alert — is something to look at, so the crane goes.
//
// Kept as a pure leaf, out of ChatPane.svelte (which was at 2476 of its 2477
// cap), because it is a RULE: it wants a test per kind, and a test per kind is
// exactly what would have caught the original.

import type { Message } from './chatMessage';

/** Rows that are pane bookkeeping rather than transcript content. */
const SCAFFOLD: ReadonlySet<Message['kind']> = new Set<Message['kind']>([
  'system',
  'verdict',
  'todoSummary',
  'compacted',
]);

/** True once the transcript holds anything worth reading — the empty state
 *  shows while this is false, and never over content again. */
export function hasConversation(messages: readonly Message[]): boolean {
  return messages.some((m) => !SCAFFOLD.has(m.kind));
}
