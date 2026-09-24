// chatFocus.ts — which transcript rows survive focus view.
//
// Focus view answers one question: "what did we actually say to each
// other?" It is a view, never an edit — one click on the composer's eye
// brings hidden rows back. Hiding the wrong row costs one click; a view
// that still draws forty tool cards costs the whole feature.
//
// A pure leaf: the dispositions below are the only thing that can be
// wrong, and chatFocus.test.ts asserts them directly.
// EVERY kind ChatTranscript.svelte dispatches on, and its disposition:
//
//   user          VISIBLE — the user's own words.
//   agent         VISIBLE — the model's answer.
//   peer          VISIBLE — another agent's prose in a collab; hiding it
//                           would empty a view meant to show the conversation.
//   system        VISIBLE — host-written prose with no other home (a
//                           handoff from another session).
//   error         VISIBLE — a failed turn's failure is the answer.
//   tool          HIDDEN  — tool activity, the loudest thing to hide, INCLUDING
//                           a `read` that produced a picture (t-h4o65t): it
//                           folds into the reads gap like any other read.
//   thought       HIDDEN  — reasoning blocks (ThoughtPill).
//   todoSummary   HIDDEN  — the agent's own task tracking, not conversation.
//   verdict       HIDDEN  — per-turn bookkeeping, hidden by kind even when
//                           it falls through to a plain MessageRow.
//   compacted     HIDDEN  — context housekeeping (the /compact marker).
//   secondOpinion VISIBLE — a review the user asked for, with a hand-over
//                           control; visible by the fail-open rule below.
//
// Unknown kinds are visible by construction: the set names what to hide, so
// a kind added later keeps showing until someone decides otherwise.

const HIDDEN_IN_FOCUS: ReadonlySet<string> = new Set([
  'tool',
  'thought',
  'todoSummary',
  'verdict',
  'compacted',
]);

/** Takes `{ kind: string }` rather than `Message`, so the fail-open case can
 *  be tested with a genuinely unknown kind, not a cast through the union. */
export function visibleInFocus(msg: { kind: string }): boolean {
  return !HIDDEN_IN_FOCUS.has(msg.kind);
}

/** An agent turn with nothing to show: no prose, no attached images — the
 *  whole step was edits or a tool cancel, which the table above already
 *  keeps VISIBLE by kind (an agent turn is a real answer, usually). The ONE
 *  definition both callers share (t-di3a0w): ChatTranscript.svelte still
 *  hides the row's bubble in focus view, and focusGaps.ts's `foldForFocus`
 *  swallows the row entirely so it stops acting as a boundary between two
 *  tool runs — a duplicated predicate that drifted is exactly how three
 *  foreground tool runs each got their own "1 tool" divider instead of one
 *  summed divider (the owner's screenshot). Takes the same loose shape as
 *  `visibleInFocus` rather than the full `Message` union, so a row missing
 *  `images` (older sessions) still narrows correctly instead of throwing. */
export function isEmptyAgentTurn(msg: { kind: string; text?: string; images?: string[] }): boolean {
  return msg.kind === 'agent' && !(msg.text ?? '').trim() && (!msg.images || msg.images.length === 0);
}
