// chatScrollRearm.ts — RE-ARMING the follow, against a bottom that MOVES.
//
// chatScroll.ts answers "is this scroller at its bottom?". That question alone
// leaves two ways for a transcript to stop following and never start again:
//
// (a) THE GROWTH RACE. `scroll` is queued to the next rendering opportunity.
//     The user drags back to the bottom they can SEE; before the event runs,
//     another chunk grows scrollHeight, so the handler measures against a
//     bottom that has moved and reads "still 400px up". The latch stays off,
//     and growth fires no scroll event of its own, so nothing re-measures.
// (b) THE DEAD WHEEL LATCH. An upward wheel on a pane with nothing to scroll
//     fires `wheel` and no `scroll`. The latch goes off with nothing left to
//     turn it back on, and the transcript freezes at the top for the whole turn.
//
// So this leaf remembers the metrics the user last SAW and answers the re-arm
// questions against them. Both surfaces import it, so they cannot drift apart.
import { STICK_THRESHOLD_PX, dropScrollAnchor, isNearBottom, markScrollAnchor } from './chatScroll';
import { recordScroll, seenOf } from './chatScrollSeen'; // the record itself, which our own scrolls write too (t-v47ytt)

/** Is there anything to scroll at all? A pane shorter than its viewport is at
 *  its bottom by definition, so "they scrolled away" cannot be true of it. */
export const canScroll = (el: Element) => el.scrollHeight - el.clientHeight > STICK_THRESHOLD_PX;
// The upward-wheel rule (b) lives in chatScrollInput.ts, with the other inputs that move the transcript.

/**
 * A scroll landed: does the transcript follow again? Records what the user now
 * sees, and answers against what they saw BEFORE — a scroll that moved DOWN
 * onto the previous bottom is a return to the bottom even when content has
 * grown past it since (a). A scroll that moved UP follows only if it is near
 * the bottom as it stands NOW. Marks the anchor, as the bare handler did.
 * The late event for OUR OWN move, with the scroller still where we put it, is
 * not the reader: it keeps the latch as `stuck` had it (chatScrollSeen.ts).
 */
export function rearmOnScroll(el: Element, stuck: boolean): boolean {
  const prev = seenOf(el);
  markScrollAnchor(el);
  recordScroll(el);
  const atBottomNow = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  if (!atBottomNow && prev?.echo && Math.abs(el.scrollTop - prev.top) <= 1) return stuck;
  if (atBottomNow || !prev || el.scrollTop < prev.top) return atBottomNow;
  return Math.abs(el.scrollTop - (prev.height - el.clientHeight)) <= STICK_THRESHOLD_PX;
}

/**
 * Content grew under an UNSTUCK scroller: has it come back on its own? Two
 * answers re-arm — the pane cannot scroll (b), or the user is sitting on the
 * bottom they last saw (a). With no record of that bottom the latch stays off:
 * an upward wheel is evidence in its own right and outranks a position the
 * browser has not repainted yet. Drops the anchor on the way out, or the
 * position the last scroll left behind would still read as "the user moved".
 */
export function rearmOnGrowth(el: Element): boolean {
  const s = seenOf(el);
  if (canScroll(el) && (!s || Math.abs(el.scrollTop - (s.height - s.client)) > STICK_THRESHOLD_PX)) return false;
  dropScrollAnchor(el);
  return true;
}
