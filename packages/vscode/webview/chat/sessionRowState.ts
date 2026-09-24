// sessionRowState.ts: the sidebar row's visual activity state, above
// the raw turn-lifecycle state ChatsList.svelte tracks ('idle' |
// 'working' | 'ready'). DOM-free, so the priority rule is testable without jsdom.
//
// A third state, 'waiting', signals the engine is parked on the user: a
// tool-permission ask is open, or the agent asked a question mid-turn.
// Both land as the same state (one "needs you"), since the wire carries
// them through the identical permission messages and the user's next
// move is identical either way — open the chat, answer it.
// waiting beats working: an approval or question mid-turn means the
// engine is parked on the user, not actively moving, so a spinner
// (claiming live activity) would be a lie.
// A fourth state, 'subagents', covers what the engine's own per-session
// run state can't: a parent session goes idle the instant its own
// runner ends, even while a detached background child keeps running.
// 'subagents' beats ready/idle but never working (a live foreground
// turn is the louder truth) and never beats waiting, for the same
// reason. Tracked by runningChildren.ts, this file's sibling leaf.

export type RowTurnState = 'idle' | 'working' | 'ready';
export type RowVisualState = RowTurnState | 'waiting' | 'subagents';

/** waiting beats everything; working beats subagents; otherwise shows the row's own turn state. */
export function deriveRowVisualState(turnState: RowTurnState, waitingForUser: boolean, subagentsRunning = false): RowVisualState {
  if (waitingForUser) return 'waiting';
  if (turnState === 'working') return 'working';
  return subagentsRunning ? 'subagents' : turnState;
}

/** A session's open asks: toolCallIds not yet answered. A plain
 *  `ReadonlySet`, not a class: $state reactivity needs a fresh Set
 *  instance on change but a same-reference no-op when nothing changed. */
export type PendingAsks = ReadonlySet<string>;

/** Record a fresh ask (a `requestPermission` wire message) against a
 *  session's set. Re-adding an id already tracked is a no-op. */
export function addPendingAsk(asks: PendingAsks, toolCallId: string): PendingAsks {
  if (asks.has(toolCallId)) return asks;
  return new Set(asks).add(toolCallId);
}

/** Drop a resolved ask (`permissionAudit`, action 'approved'/'denied').
 *  The message carries no sessionId, so the caller offers the same
 *  toolCallId to every session's set; a miss here is a no-op. */
export function removePendingAsk(asks: PendingAsks, toolCallId: string): PendingAsks {
  if (!asks.has(toolCallId)) return asks;
  const next = new Set(asks);
  next.delete(toolCallId);
  return next;
}
