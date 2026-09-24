// Does this collab NEED the user right now?
//
// A collab tab's title was written once, at open, and never updated, so a
// room could block on a question with nothing to say so. Reads a
// `collab_state` payload and answers one question, pure and testable without
// a webview, poll or engine. Does NOT badge "an agent is running" — only a
// tripped loop breaker or a finished task, the two things only the user can clear.

/** The slice of a `collab_state` payload the rule reads. Structural, so both
 *  the host's own poll and a webview payload satisfy it as they stand. */
export interface CollabAttentionState {
  suspended?: boolean;
  agents?: readonly { state?: string }[];
  tasks?: readonly { state?: string }[];
}

export function collabNeedsUser(state: CollabAttentionState): boolean {
  // The loop breaker tripped: the room is waiting on a human by construction.
  if (state.suspended === true) return true;
  // Work in flight means the next move is the AGENT's, whatever is on the board.
  const busy = (state.agents ?? []).some((a) => a.state === 'running' || a.state === 'queued');
  if (busy) return false;
  return (state.tasks ?? []).some((t) => t.state === 'done');
}
