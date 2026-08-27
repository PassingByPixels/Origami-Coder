// Does this collab NEED the user right now? (report F12 / 1.13)
//
// A collab tab's title was written once, at open, and never touched again — so a
// room working behind three other editor tabs could block on a question and sit
// there with nothing to say so. A chat tab has carried a waiting badge since 0.3
// (`tabIcon.waitingTitleFor`); this is the same signal, for the other surface.
//
// THE RULE IS ITS OWN FILE, and pure. It reads a `collab_state` payload — the
// same one every surface already gets — and answers one question, so the answer
// is testable without a webview panel, a poll or an engine. `collabTab.ts` owns
// the one line of VS Code state it drives.
//
// WHAT IT DELIBERATELY DOES NOT BADGE: "an agent is running". A working room is
// the normal case, and a badge that is always on is a badge nobody reads. The
// two things it does badge are the two the user is the ONLY one who can clear:
// a tripped loop breaker (no agent will speak again until a human posts) and a
// finished task sitting on the board waiting to be accepted or sent back.
//
// Every field is OPTIONAL by the wire contract — an older engine sends no tasks
// and no statuses at all — and every absence reads as "nothing known to be
// owed", never as a badge.

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
