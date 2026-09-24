// chatScrollInput.ts — which inputs move the TRANSCRIPT scroller (t-v47ytt). The follow may be
// released only by a wheel or scroll that moves the transcript, and a transcript that reaches its
// bottom by any route re-arms. Two routes were missing (both measured in Chromium):
//
// - AN UPWARD WHEEL INSIDE A TOOL BOX. The browser gives the wheel to the innermost box that can
//   still scroll that way, and to the transcript only when none can. The wheel released the follow
//   anyway, so the transcript froze and the jump pill came up while it had not moved.
// - A RESIZE. The composer losing a line (or the window growing) brings a reader who was a few
//   pixels up onto the bottom with scrollTop unchanged, so no scroll event fires and the pill stayed.
import { isNearBottom, stickToBottom } from './chatScroll';
import { canScroll } from './chatScrollRearm';
import { forgetSeen, noteSeen } from './chatScrollSeen';

/** Does an upward wheel from `from` scroll a box INSIDE `el` instead of `el`? Only a box that can
 *  scroll up has a scrollTop above 0 (a browser keeps it at 0 on anything that cannot scroll). */
export function innerTakesWheel(el: Element, from: EventTarget | null): boolean {
  for (let n = from instanceof Element ? from : null; n && n !== el; n = n.parentElement) if (n.scrollTop > 0) return true;
  return false;
}

/** An upward wheel means "reading back" only where it moves the transcript: it has room to scroll (a
 *  pane with nothing to scroll must not latch the follow off) and no box inside takes the wheel. It
 *  also forgets the seen bottom, so a chunk in the same frame cannot re-arm off a position the wheel
 *  is about to move. */
export const wheelUnsticks = (el: Element, deltaY: number, from: EventTarget | null = null): boolean =>
  deltaY < 0 && canScroll(el) && !innerTakesWheel(el, from) && (forgetSeen(el), true);

/** The scroller's box changed size. ARMED: pin to the bottom at once, or a composer that grew hides
 *  the newest lines until the next chunk. RELEASED: re-arm only if the resize put the reader on the
 *  bottom; their place is theirs. True = following now. A resize never releases the follow. */
export function followOnResize(el: Element, stuck: boolean): boolean {
  const follows = stuck ? stickToBottom(el) : isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  noteSeen(el, stuck && follows);
  return follows;
}

/** Svelte action: call `onResize(node)` when the node's box changes size. No ResizeObserver (an old
 *  runtime, jsdom), no call: the scroll and growth rules still hold. */
export function watchResize(node: Element, onResize: (el: Element) => void) {
  if (typeof ResizeObserver === 'undefined') return {};
  let run = onResize;
  const ro = new ResizeObserver(() => run(node));
  ro.observe(node);
  return { update(next: (el: Element) => void) { run = next; }, destroy() { ro.disconnect(); } };
}
