// chatFocus.ts — WHICH transcript rows survive FOCUS VIEW.
//
// Focus view answers one question: "what did we actually say to each other?"
// It is a VIEW, never an edit — the rows stay in the list, in order, and one
// click on the composer's eye brings the hidden ones back. That is what lets
// the rule below be this blunt: hiding the wrong row costs one click, while a
// "just the conversation" view that still draws forty tool cards costs the
// whole feature.
//
// A pure leaf on purpose (no DOM, no `vscode`, no Svelte): the dispositions
// are the only thing here that can be WRONG, and chatFocus.test.ts asserts
// them directly instead of through a rendered transcript.
//
// EVERY kind ChatTranscript.svelte dispatches on, and its disposition:
//
//   user        VISIBLE — the user's own words; half of the conversation.
//   agent       VISIBLE — the model's answer; the other half.
//   peer        VISIBLE — another agent's prose in a collab chat. THERE the
//                         peers' answers ARE the conversation, so hiding them
//                         would empty the very view meant to show it.
//   system      VISIBLE — host-written prose that lands in the transcript with
//                         no other home (a handoff from another session).
//   error       VISIBLE — when a turn fails, the failure IS the answer. A
//                         focus view that swallowed it would show a silence
//                         where something went wrong.
//   tool        HIDDEN  — tool activity; the single loudest thing the owner
//                         asked to be rid of.
//   thought     HIDDEN  — reasoning blocks (ThoughtPill).
//   todoSummary HIDDEN  — the agent's own task tracking, not conversation.
//   verdict     HIDDEN  — per-turn terminal bookkeeping ABOUT a turn, not a
//                         line spoken in it. Hidden BY KIND, not by payload: a
//                         `verdict` row carrying no verdict falls through to a
//                         plain MessageRow in the transcript, and it is still
//                         turn metadata when it does.
//   compacted   HIDDEN  — context housekeeping (the /compact marker).
//
// UNKNOWN KINDS ARE VISIBLE, by construction: the set names what to HIDE, so a
// kind added later keeps showing until somebody decides otherwise. A new
// message type silently swallowed by an old view is a defect nobody can see.

const HIDDEN_IN_FOCUS: ReadonlySet<string> = new Set([
  'tool',
  'thought',
  'todoSummary',
  'verdict',
  'compacted',
]);

/** Takes `{ kind: string }` rather than `Message`: `kind` is the only field the
 *  rule reads, and a plain `string` is what lets the fail-open case be tested
 *  with a genuinely unknown kind instead of a cast through the closed union.
 *  Every `Message` is assignable to it. */
export function visibleInFocus(msg: { kind: string }): boolean {
  return !HIDDEN_IN_FOCUS.has(msg.kind);
}
