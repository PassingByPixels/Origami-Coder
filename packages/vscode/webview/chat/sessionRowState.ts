// sessionRowState.ts — the sidebar row's VISUAL activity state, one layer
// above the raw turn-lifecycle state ChatsList.svelte already tracks
// ('idle' | 'working' | 'ready'). DOM-free by the same chatSections.ts
// precedent (this directory's established pattern), so the priority rule is
// testable without jsdom's missing layout engine.
//
// A THIRD visual state — 'waiting' — signals the engine is parked on the
// user: a tool-permission ask is open, or the agent asked a question
// mid-turn. Both land here as the SAME state (one semantic "needs you", not
// two): the wire carries both through the identical `requestPermission` /
// `permissionAudit` messages (DashboardPanel.ts's onPermissionRequest posts
// `requestPermission` whether or not the ask offers `allow_always`; a
// question is only ever the shape of that same ask with no allow_always
// option — see permissionOptions.ts's isQuestionShaped), so distinguishing
// them here would need extra state the ring has no use for: the user's next
// move is identical either way — open the chat, answer it.
//
// waiting BEATS working: an approval or question mid-turn means the engine
// is not actively moving, it is parked on the user, so the spin (which
// claims live activity) would be a lie the instant a real ask is open.

export type RowTurnState = 'idle' | 'working' | 'ready';
export type RowVisualState = RowTurnState | 'waiting';

/** waiting-for-user beats the turn state; otherwise the row shows its own
 *  turn state unchanged. */
export function deriveRowVisualState(turnState: RowTurnState, waitingForUser: boolean): RowVisualState {
  return waitingForUser ? 'waiting' : turnState;
}

/** A session's open asks: toolCallIds the user has not yet answered. Plain
 *  `ReadonlySet` rather than a class — ChatsList.svelte already models each
 *  row as a plain object, and $state reactivity needs a fresh Set instance
 *  on every change, which these two functions guarantee (no in-place
 *  mutation) while staying a no-op (same reference back) when nothing
 *  actually changed. */
export type PendingAsks = ReadonlySet<string>;

/** Record a fresh ask (a `requestPermission` wire message) against a
 *  session's set. Re-adding an id already tracked is a no-op. */
export function addPendingAsk(asks: PendingAsks, toolCallId: string): PendingAsks {
  if (asks.has(toolCallId)) return asks;
  return new Set(asks).add(toolCallId);
}

/** Drop a resolved ask (a `permissionAudit` message with action 'approved'
 *  or 'denied') from a session's set. `permissionAudit` carries no
 *  sessionId (DashboardPanel.ts posts it as a global audit-feed entry), so
 *  the caller offers the same toolCallId to every session's set; a miss
 *  here (this session never held it) is a no-op. */
export function removePendingAsk(asks: PendingAsks, toolCallId: string): PendingAsks {
  if (!asks.has(toolCallId)) return asks;
  const next = new Set(asks);
  next.delete(toolCallId);
  return next;
}
