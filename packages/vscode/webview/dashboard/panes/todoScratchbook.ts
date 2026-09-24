// The todo list's VISIBILITY rule, split out of ChatPane.svelte — which sits
// exactly on its 2700-line cap, so the predicate that replaced three scattered
// clears needed a file of its own.
//
// THE DEFECT it exists to fix (owner report: "todo ... gets dropped more often
// now — this isn't the intended design of a scratchbook style"). The ENGINE's
// list is durable (0.3.88: a persisted TodoTable, compaction + fork coverage, an
// `origami/todoSnapshot` replay). The PANE was the leak: it treated `todos` as a
// per-turn echo of the wire and threw it away in four places — end of linger,
// next send, error, disconnect — behind a gate on `inFlight || lingering`.
//
// Why that reads as "dropped MORE often now": a session that fans work out to
// BACKGROUND sub-agents ends a turn seconds after each spawn while the children
// run for many minutes, and every one of those turn ends started the 1.8s
// linger — so the checklist for the work still in flight blinked out.
//
// THE RULE: a list is on screen while it still has OPEN WORK. Not the turn, not
// the linger — the WORK decides. Completion is what retires it, at which point
// ChatPane settles the collapsed one-liner into the transcript. Keying on
// completion rather than "always on" is what stops a long-finished recalled
// session from wearing a stale green checklist forever, which is the concern the
// old `inFlight || lingering` gate was reaching for by proxy.

import { tabWorthKeeping, type SubagentTodoList } from '../components/todoTabs';

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
 *
 * t-geo4n3 — the panel is the home of EVERY list in the chat. This read the
 * main list alone, so the owner's main list going 1/1 done retired the panel
 * and took four children's lists with it. Any sub-agent list that earns a tab
 * (`tabWorthKeeping`) holds it up; the linger now covers only "nothing left".
 */
export function todoOverlayVisible(
  inFlight: boolean,
  lingering: boolean,
  todos: readonly TodoRow[],
  subagents: readonly SubagentTodoList[] = [],
): boolean {
  if (subagents.some(tabWorthKeeping)) return true;
  if (todos.length === 0) return false;
  return hasOpenWork(todos) || inFlight || lingering;
}
