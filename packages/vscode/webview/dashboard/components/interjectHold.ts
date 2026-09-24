// interjectHold.ts — what an Enter mid-turn does when it is NOT an
// interjection, and what the composer SAYS about it.
//
// The interject wire carries the line and its pictures now (interjectSplit.ts,
// src/dashboard/turnMessages.ts), so the ordinary mid-turn Enter goes straight
// into the running turn. Two states still cannot, and both used to do the same
// thing: NOTHING. No send, no chip, no word — the owner's report of a composer
// showing Send and Cancel with a picture attached, where pressing Send did
// nothing at all (t-4ahs3u).
//
//   a SLASH command — its side effects (`/compact`, `/export`) act on the
//     session, not on the turn, so running one inside a turn would act on a
//     transcript that is still moving. The draft is KEPT, not held: the user
//     presses Send again when the turn is over.
//   NO route — a composer mounted with no `onInterject` (the bare collab
//     surface) has no turn of its own to reach into. A draft with something
//     attached is HELD and goes out at the turn boundary, which is what that
//     mount already did; a plain line is kept the same way a slash one is.
//
// A rule, not a component: the SENTENCE is the thing under test, and a wrong
// one is a promise the composer does not keep ("sent when the turn ends" over a
// draft nothing will ever send). InterjectingChip.svelte draws it.

/** Kept on screen, and sent by nobody — the user re-sends when the turn ends. */
export const SLASH_WAITS = 'A slash command cannot go into a running turn. Send it again when the turn ends.';
/** Kept on screen, and the composer sends it itself at the turn boundary. */
export const HELD_FOR_IDLE = 'This composer cannot add to a running turn. The message is sent when the turn ends.';
/** Kept on screen, and sent by nobody. Same mount, nothing attached to hold. */
export const NO_TURN_ROUTE = 'This composer cannot add to a running turn. Send it again when the turn ends.';

/** `held` = the composer re-sends this draft the moment the turn ends. */
export interface InterjectHold {
  held: boolean;
  reason: string;
}

/**
 * The mid-turn Enter's verdict. `null` = deliver it into the turn, which is
 * every ordinary line and every ordinary attachment.
 */
export function interjectHold(
  isSlash: boolean,
  canInterject: boolean,
  hasAttachments: boolean,
): InterjectHold | null {
  if (isSlash) return { held: false, reason: SLASH_WAITS };
  if (canInterject) return null;
  // Unchanged from before the interject wire took attachments: the hold exists
  // for a draft that has something the user cannot retype, and only for that.
  if (hasAttachments) return { held: true, reason: HELD_FOR_IDLE };
  return { held: false, reason: NO_TURN_ROUTE };
}
