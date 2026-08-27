// The todo list's VISIBILITY rule, split out of ChatPane.svelte — which sits
// exactly on its 2700-line cap, so the predicate that replaced three scattered
// clears needed a file of its own.
//
// THE DEFECT it exists to fix (owner report: "todo is more solid now but it kind
// of gets dropped more often now — this isn't the intended design of a
// scratchbook style"). The ENGINE's list is durable: 0.3.88 gave it a persisted
// TodoTable, compaction-window and fork coverage, and an `origami/todoSnapshot`
// replay on load/resume/fork. The PANE was the leak. It treated `todos` as a
// per-turn echo of the wire rather than a projection of that durable state, and
// threw it away in four places — at the end of the post-turn linger, at the
// start of the next send, on error, and on disconnect — behind an overlay gated
// on `inFlight || lingering`.
//
// Why that reads as "dropped MORE often now": a session that fans work out to
// BACKGROUND sub-agents ends a turn seconds after each spawn (the `task` tool
// returns "started in the background" and the model stops talking) while the
// children run for many minutes. Every one of those turn ends started the 1.8s
// linger, so the checklist for the very work still in flight blinked out and did
// not return until the model happened to write it again. The better the engine
// got at keeping the list, the more turns there were to lose it on.
//
// THE RULE: a list is on screen while it still has OPEN WORK. Not the turn, not
// the linger — the WORK decides. Completion is what retires it, at which point
// ChatPane settles the collapsed one-liner into the transcript. Keying on
// completion rather than "always on" is what stops a long-finished recalled
// session from wearing a stale green checklist forever, which is the concern the
// old `inFlight || lingering` gate was reaching for by proxy.

export interface TodoRow {
  status: 'pending' | 'in_progress' | 'completed';
}

/** True while any row is still outstanding — the scratchbook has work in it. */
export function hasOpenWork(todos: readonly TodoRow[]): boolean {
  return todos.some((t) => t.status !== 'completed');
}

/**
 * Whether the live overlay is drawn.
 *
 * `inFlight` and `lingering` remain inputs for the two cases where a list with
 * NO open work should still be seen: a model that writes its todos all at once
 * at the very end of a turn (otherwise the panel would appear for ~0ms), and a
 * list that has just been completed, which holds the screen for the linger
 * before it retires into the transcript.
 */
export function todoOverlayVisible(
  inFlight: boolean,
  lingering: boolean,
  todos: readonly TodoRow[],
): boolean {
  if (todos.length === 0) return false;
  return hasOpenWork(todos) || inFlight || lingering;
}
