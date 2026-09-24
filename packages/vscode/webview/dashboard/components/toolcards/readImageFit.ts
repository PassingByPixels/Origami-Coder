// readImageFit.ts — HOW TALL A READ-IMAGE CARD IS ALLOWED TO BE.
//
// CHANGES.md change 45: the bundle capped `.tool-result` at 200px with
// `overflow: auto`, so the one card whose content IS the point arrived as a
// letterbox with its own scrollbar inside an already-scrolling transcript. The
// card now takes the image's own height and the PANE is the only cap.
//
// The pane is the cap and not a viewport unit, because the transcript is not
// the viewport: it shares the window with the composer, the header and, in
// multi-up, three other chats. `60vh` would be right in exactly one layout.
//
// CSS cannot read an element's height, so the measurement is done here and
// handed to CSS as a custom property. The pure half is separated from the DOM
// half so the rule can be tested without a layout engine — which jsdom does not
// have, and which is exactly why a `max-height` claim cannot be tested any
// other way in this suite.

/** Room the card's own chrome takes above and below the picture: the header
 *  row, the result block's padding and borders, and the path line under it.
 *  Measured off the shipped card rather than guessed. */
export const CARD_CHROME_PX = 56;

/** Never shrink below this, whatever the pane is doing. A transcript mid-resize
 *  — or one in a collapsed multi-up cell — can report a height of a few pixels,
 *  and an image capped to that is not a smaller picture, it is no picture. */
export const MIN_IMAGE_PX = 160;

/** The cap, in px, for a picture drawn inside `scrollerHeight`. */
export function imageCapPx(scrollerHeight: number): number {
  if (!Number.isFinite(scrollerHeight) || scrollerHeight <= 0) return MIN_IMAGE_PX;
  return Math.max(MIN_IMAGE_PX, Math.round(scrollerHeight) - CARD_CHROME_PX);
}

/** The nearest ancestor that actually scrolls, or null if nothing does. Walks
 *  up from the element itself so a card in any container finds its own pane,
 *  rather than assuming the transcript's class name and silently missing in
 *  the sub-agent transcript, which mounts the same card somewhere else. */
export function scrollParentOf(el: Element | null): Element | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

/** Svelte action: keeps `--readimg-cap` on the element equal to the pane's
 *  current height, re-measuring when the pane resizes so the picture re-bounds
 *  instead of being sized once at mount and left wrong after a window drag.
 *
 *  With no scrolling ancestor the property is left UNSET, and the stylesheet's
 *  own fallback applies — a card rendered outside a pane (a test, a print view)
 *  should not be capped to a number invented here. */
export function fitToPane(node: HTMLElement) {
  const pane = scrollParentOf(node);
  if (!pane) return {};
  const apply = () => node.style.setProperty('--readimg-cap', `${imageCapPx(pane.clientHeight)}px`);
  apply();
  const RO = node.ownerDocument.defaultView?.ResizeObserver;
  const observer = RO ? new RO(apply) : undefined;
  observer?.observe(pane);
  return { destroy: () => observer?.disconnect() };
}
