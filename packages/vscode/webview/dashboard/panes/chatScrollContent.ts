// chatScrollContent.ts — t-xtim9n: the transcript's CONTENT changed height with no scroll event and no
// change to the scroller's own box. chatScrollInput.ts covers the inputs that move the scroller (a wheel,
// a resize of its box); this covers the content under it. A row folded or replaced in place (an engine
// card on a stop or restore), the in-flight row going at turn end, or a card that gets shorter can put
// a reader who was a few pixels up exactly on the bottom with scrollTop unchanged: no clamp, so no scroll
// event, and the follow latch (which the jump pill reads) stayed released until something resized the box.
import { isNearBottom } from './chatScroll';

/** The content changed height with no scroll event (t-xtim9n): a RELEASED follow re-arms only when that
 *  put the reader on the bottom. Records nothing, unlike followOnResize: this runs after layout and
 *  before paint, so the reader has not SEEN this height, and chatScrollSeen.ts must keep what they saw.
 *  True = following now. */
export const rearmOnContent = (el: Element, stuck: boolean): boolean =>
  stuck || isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);

/** Svelte action (t-xtim9n): call `onChange(node)` when the node's CONTENT changes height with no scroll
 *  event and no change to the node's own box: the in-flight row going at turn end, an engine card folded
 *  in place, a card or image that changes size. A ResizeObserver reports boxes, not scrollHeight, so it
 *  watches each child, and the child list is kept current. No observers (jsdom, an old runtime), no call. */
export function watchContent(node: Element, onChange: (el: Element) => void) {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return {};
  let run = onChange;
  const ro = new ResizeObserver(() => run(node));
  const observeChildren = () => { ro.disconnect(); for (const child of Array.from(node.children)) ro.observe(child); };
  observeChildren();
  const mo = new MutationObserver(() => { observeChildren(); run(node); });
  mo.observe(node, { childList: true });
  return { update(next: (el: Element) => void) { run = next; }, destroy() { ro.disconnect(); mo.disconnect(); } };
}
