// chatScroll.ts — the one rule behind "should the transcript follow the stream?"
//
// THE BUG. ChatPane's scrollToBottom fired unconditionally from every streamed
// chunk. Scroll up to re-read what the agent did four tool calls ago and the
// next token yanks you back to the bottom — so the transcript became unreadable
// exactly while it was most worth reading, and the only workaround was to stop
// the turn.
//
// The fix is a per-session STICK: follow while the user is at the bottom, stop
// the moment they scroll away, resume when they come back. This module owns the
// predicate AND the evidence a user moved, because together they are the whole
// decision and a rule nobody can test is a rule nobody can trust. Mirrors
// pinnedUser.ts's split out of the same pane.

/**
 * How far from the bottom still counts as "following".
 *
 * A ROUNDING tolerance, not a reading allowance: scrollHeight and clientHeight
 * are rounded integers while scrollTop is fractional, so a scroller parked at
 * its true bottom can still report a pixel of slack. It was 48px, where the
 * 0.4.2 fix still leaked — one arrow-key press moves ~30px, so a deliberate
 * scroll read as "at the bottom", re-armed the follow, and the next chunk
 * snapped it away. */
export const STICK_THRESHOLD_PX = 4;

/**
 * Is this scroller at (or within a hair of) its bottom?
 *
 * Content SHORTER than the viewport (scrollHeight <= clientHeight) is at the
 * bottom by definition — an empty or one-line chat must start stuck, or the
 * very first reply would never scroll into view.
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

/** Where a scroller was last left, by us or by a scroll event we saw — the only
 *  evidence a USER moved one. `scroll` is queued to the next rendering
 *  opportunity, so a drag landing before a pending frame is snapped back BEFORE
 *  its event fires and the coalesced event then reports the bottom. Growth moves
 *  the BOTTOM, not scrollTop, so it reads as no movement. */
const anchors = new WeakMap<Element, number>();
export const markScrollAnchor = (el: Element) => anchors.set(el, el.scrollTop);
export const dropScrollAnchor = (el: Element) => anchors.delete(el);

/** Follow the stream — FALSE, and no scroll, once the user has moved away. */
export function stickToBottom(el: Element): boolean {
  const anchor = anchors.get(el);
  if (anchor !== undefined && Math.abs(el.scrollTop - anchor) > 1
    && !isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) return false;
  el.scrollTop = el.scrollHeight;
  anchors.set(el, el.scrollTop); // read BACK: the browser clamps, fractionally
  return true;
}
