// WHICH engine message an agent-text delta belongs to — and when a delta for a
// different one closes the bubble that is open.
//
// The pane accumulates every `agentText` delta into ONE open bubble
// (`currentAgentMsgId`) until something closes it: a tool card, a user row, a
// thought, a compaction marker. Nothing closed it when the ENGINE moved on to a
// new assistant message, so two engine messages merged into one bubble. On a
// tidy turn that only reads as a missing paragraph break. On 2026-08-20 it read
// as garbage: a second turn loop was streaming onto the same session (fixed
// engine-side — server/server.ts memo map), and both streams landed in the same
// bubble character by character.
//
// The engine tags EVERY live text delta with its message id
// (`agent_message_chunk` in acp/event.ts), so the pane can key the open bubble
// by it. That makes a merge impossible by construction rather than by trusting
// that only one thing ever streams at a time.
//
// The rule is deliberately conservative — seal ONLY when both ids are known and
// differ:
//  - no id on the delta: keep appending (a plain ACP server sends none).
//  - bubble not yet stamped: keep appending. The first chunk of a bubble can
//    arrive before its id does, and ChatPane stamps it retroactively; sealing
//    there would split one message into two on every late stamp.
//
// A LEAF: pure, no DOM, no Svelte.

/** The fields of the pane's `Message` this rule reads. */
export interface StreamBubble {
  id: number;
  engineMsgId?: string;
}

export function sealsOpenBubble(
  messages: readonly StreamBubble[],
  openId: number | null,
  deltaEngineMsgId: string | undefined,
): boolean {
  if (openId === null || !deltaEngineMsgId) return false;
  const open = messages.find((m) => m.id === openId);
  if (!open?.engineMsgId) return false;
  return open.engineMsgId !== deltaEngineMsgId;
}
